"""Invoice lifecycle: calculation, numbering, persistence, status and PDF files."""
from __future__ import annotations

import logging
import re
from datetime import date
from decimal import Decimal
from pathlib import Path

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session, selectinload

from ..config import INVOICE_DIR
from ..errors import AppError, ConflictError, NotFoundError
from ..pdf_generator import PDF_CREATOR, generate_invoice_pdf
from ..models import BusinessSettings, Customer, DiscountType, Invoice, InvoiceItem, InvoiceStatus, Product
from ..schemas import InvoiceIn, InvoiceItemOut, InvoiceOut, InvoiceSummaryOut, TaxBreakupOut
from . import settings_service
from .calculations import ZERO, CalculationError, InvoiceTotals, LineInput, calculate_invoice
from .states import state_label

logger = logging.getLogger("billing.invoices")

# Statuses whose value is derived from payments and due date rather than set by hand.
_OPEN_STATUSES = (InvoiceStatus.PENDING, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE)
MANUAL_STATUSES = (InvoiceStatus.DRAFT, InvoiceStatus.PENDING, InvoiceStatus.PAID, InvoiceStatus.CANCELLED)


# ---------------------------------------------------------------------------
# Building invoice values
# ---------------------------------------------------------------------------


def _customer_snapshot(customer: Customer) -> dict:
    fields = (
        "name", "company_name", "phone", "email", "billing_address",
        "shipping_address", "gstin", "state", "state_code",
    )
    return {field: getattr(customer, field) or "" for field in fields}


def _require_configured(settings: BusinessSettings) -> None:
    if not settings_service.is_configured(settings):
        raise AppError("Please complete your business profile (name and state) in Settings before creating invoices.")


def _get_customer(db: Session, customer_id: int) -> Customer:
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise AppError("Selected customer does not exist.", 422)
    return customer


def _validate_products(db: Session, payload: InvoiceIn) -> None:
    product_ids = {item.product_id for item in payload.items if item.product_id is not None}
    if not product_ids:
        return
    found = set(db.scalars(select(Product.id).where(Product.id.in_(product_ids))))
    missing = product_ids - found
    if missing:
        raise AppError("One or more selected products no longer exist.", 422)


def _calculate(payload: InvoiceIn, settings: BusinessSettings, customer: Customer) -> tuple[str, InvoiceTotals]:
    place_of_supply = payload.place_of_supply or customer.state_code or settings.state_code
    is_interstate = place_of_supply != settings.state_code
    lines = [
        LineInput(
            quantity=item.quantity,
            rate=item.rate,
            gst_rate=item.gst_rate,
            discount_type=item.discount_type,
            discount_value=item.discount_value,
        )
        for item in payload.items
    ]
    try:
        return place_of_supply, calculate_invoice(lines, is_interstate)
    except CalculationError as exc:
        raise AppError(str(exc), 422) from exc


def _derive_status(invoice: Invoice, today: date | None = None) -> InvoiceStatus:
    if invoice.status in (InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED):
        return invoice.status
    today = today or date.today()
    paid = invoice.amount_paid or ZERO
    if paid >= invoice.grand_total:
        return InvoiceStatus.PAID
    if invoice.due_date and invoice.due_date < today:
        return InvoiceStatus.OVERDUE
    return InvoiceStatus.PARTIALLY_PAID if paid > ZERO else InvoiceStatus.PENDING


def _apply(
    invoice: Invoice,
    payload: InvoiceIn,
    settings: BusinessSettings,
    customer: Customer,
    place_of_supply: str,
    totals: InvoiceTotals,
) -> None:
    invoice.customer_id = customer.id
    invoice.invoice_date = payload.invoice_date
    invoice.due_date = payload.due_date
    invoice.place_of_supply = place_of_supply
    invoice.is_interstate = totals.is_interstate
    invoice.payment_terms = payload.payment_terms
    invoice.other_reference = payload.other_reference
    invoice.contact_phone = payload.contact_phone
    invoice.esn = payload.esn
    invoice.subtotal = totals.subtotal
    invoice.discount = totals.discount
    invoice.taxable_amount = totals.taxable_amount
    invoice.cgst = totals.cgst
    invoice.sgst = totals.sgst
    invoice.igst = totals.igst
    invoice.round_off = totals.round_off
    invoice.grand_total = totals.grand_total
    invoice.amount_in_words = totals.amount_in_words
    invoice.notes = payload.notes
    invoice.terms = payload.terms
    invoice.customer_snapshot = _customer_snapshot(customer)
    invoice.business_snapshot = settings_service.business_snapshot(settings)
    invoice.items = [
        InvoiceItem(
            position=position,
            product_id=item.product_id,
            part_no=item.part_no,
            name=item.name,
            description=item.description,
            hsn_sac=item.hsn_sac,
            quantity=item.quantity,
            unit=item.unit,
            rate=item.rate,
            discount_type=DiscountType(item.discount_type),
            discount_value=item.discount_value,
            gross_amount=line.gross_amount,
            discount=line.discount,
            gst_rate=item.gst_rate,
            taxable_amount=line.taxable_amount,
            cgst=line.cgst,
            sgst=line.sgst,
            igst=line.igst,
            tax_amount=line.tax_amount,
            amount=line.amount,
        )
        for position, (item, line) in enumerate(zip(payload.items, totals.lines, strict=True))
    ]


# ---------------------------------------------------------------------------
# Public operations
# ---------------------------------------------------------------------------


def preview_invoice(db: Session, payload: InvoiceIn, invoice_id: int | None = None) -> InvoiceOut:
    """Compute an invoice exactly as it would be saved, without persisting it."""
    settings = settings_service.get_settings(db)
    _require_configured(settings)
    customer = _get_customer(db, payload.customer_id)
    place_of_supply, totals = _calculate(payload, settings, customer)

    invoice = Invoice(status=InvoiceStatus(payload.status), amount_paid=ZERO)
    _apply(invoice, payload, settings, customer, place_of_supply, totals)
    if payload.invoice_number:
        invoice.invoice_number = payload.invoice_number
    elif invoice_id is not None:
        existing = get_invoice(db, invoice_id)
        invoice.invoice_number = existing.invoice_number
    else:
        invoice.invoice_number, _ = settings_service.next_invoice_number(db, settings)
    # The invoice is never added to the session, so nothing here is persisted.
    return to_out(invoice, db)


def create_invoice(db: Session, payload: InvoiceIn) -> Invoice:
    settings = settings_service.get_settings(db)
    _require_configured(settings)
    customer = _get_customer(db, payload.customer_id)
    _validate_products(db, payload)
    place_of_supply, totals = _calculate(payload, settings, customer)

    if payload.invoice_number:
        number = payload.invoice_number
        if db.scalar(select(Invoice.id).where(Invoice.invoice_number == number)) is not None:
            raise ConflictError(f"Invoice number {number} is already in use.")
        sequence = settings_service.parse_sequence(number, settings.invoice_prefix, settings.invoice_suffix)
    else:
        number, sequence = settings_service.next_invoice_number(db, settings)

    invoice = Invoice(invoice_number=number, status=InvoiceStatus(payload.status), amount_paid=ZERO)
    _apply(invoice, payload, settings, customer, place_of_supply, totals)
    invoice.status = _derive_status(invoice)
    if sequence is not None and sequence > settings.last_invoice_number:
        settings.last_invoice_number = sequence

    db.add(invoice)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ConflictError(f"Invoice number {number} is already in use. Please try again.") from exc

    _try_write_pdf(db, invoice)
    logger.info("Created invoice %s (total %s)", invoice.invoice_number, invoice.grand_total)
    return invoice


def update_invoice(db: Session, invoice: Invoice, payload: InvoiceIn) -> Invoice:
    if invoice.status in (InvoiceStatus.PAID, InvoiceStatus.CANCELLED) or invoice.amount_paid > ZERO:
        raise AppError("Paid, partially paid or cancelled invoices cannot be edited.", 409)
    settings = settings_service.get_settings(db)
    _require_configured(settings)
    customer = _get_customer(db, payload.customer_id)
    _validate_products(db, payload)
    place_of_supply, totals = _calculate(payload, settings, customer)

    number = payload.invoice_number or invoice.invoice_number
    if number != invoice.invoice_number:
        clash = db.scalar(select(Invoice.id).where(Invoice.invoice_number == number, Invoice.id != invoice.id))
        if clash is not None:
            raise ConflictError(f"Invoice number {number} is already in use.")
        _delete_pdf(invoice)
        invoice.invoice_number = number

    invoice.status = InvoiceStatus(payload.status)
    _apply(invoice, payload, settings, customer, place_of_supply, totals)
    invoice.status = _derive_status(invoice)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ConflictError(f"Invoice number {number} is already in use.") from exc
    _try_write_pdf(db, invoice)
    return invoice


def set_status(db: Session, invoice: Invoice, status: InvoiceStatus) -> Invoice:
    if status not in MANUAL_STATUSES:
        raise AppError(f"'{status.value}' is set automatically from payments and due dates.", 422)
    if invoice.status == InvoiceStatus.CANCELLED and status != InvoiceStatus.CANCELLED:
        raise AppError("A cancelled invoice cannot be reopened. Create a new invoice instead.", 409)
    if status == InvoiceStatus.DRAFT and invoice.amount_paid > ZERO:
        raise AppError("An invoice with recorded payments cannot be moved back to Draft.", 409)

    if status == InvoiceStatus.PAID:
        invoice.amount_paid = invoice.grand_total
        invoice.status = InvoiceStatus.PENDING
    else:
        invoice.status = status
    invoice.status = _derive_status(invoice)
    db.commit()
    return invoice


def record_payment(db: Session, invoice: Invoice, amount: Decimal) -> Invoice:
    if invoice.status in (InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED):
        raise AppError("Payments can only be recorded against issued invoices.", 409)
    if amount > invoice.balance_due:
        raise AppError(f"Payment exceeds the balance due of ₹{invoice.balance_due:,}.", 422)
    invoice.amount_paid = (invoice.amount_paid or ZERO) + amount
    invoice.status = _derive_status(invoice)
    db.commit()
    return invoice


def refresh_overdue(db: Session, today: date | None = None) -> None:
    """Re-derive statuses of open invoices so 'Overdue' always reflects today's date."""
    changed = False
    for invoice in db.scalars(select(Invoice).where(Invoice.status.in_(_OPEN_STATUSES))):
        status = _derive_status(invoice, today)
        if status != invoice.status:
            invoice.status = status
            changed = True
    if changed:
        db.commit()


def delete_invoice(db: Session, invoice: Invoice) -> None:
    _delete_pdf(invoice)
    db.delete(invoice)
    db.commit()


def get_invoice(db: Session, invoice_id: int) -> Invoice:
    invoice = db.scalar(
        select(Invoice).options(selectinload(Invoice.items)).where(Invoice.id == invoice_id)
    )
    if invoice is None:
        raise NotFoundError("Invoice")
    return invoice


def list_invoices(
    db: Session,
    q: str = "",
    status: str = "",
    customer_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[InvoiceSummaryOut], int]:
    refresh_overdue(db)
    query = select(Invoice).outerjoin(Customer, Invoice.customer_id == Customer.id)
    if q:
        pattern = f"%{q}%"
        query = query.where(
            or_(
                Invoice.invoice_number.ilike(pattern),
                Customer.name.ilike(pattern),
                Customer.company_name.ilike(pattern),
            )
        )
    if status == "open":
        query = query.where(Invoice.status.in_(_OPEN_STATUSES))
    elif status:
        try:
            query = query.where(Invoice.status == InvoiceStatus(status))
        except ValueError as exc:
            raise AppError("Unknown invoice status filter.", 422) from exc
    if customer_id is not None:
        query = query.where(Invoice.customer_id == customer_id)
    if date_from:
        query = query.where(Invoice.invoice_date >= date_from)
    if date_to:
        query = query.where(Invoice.invoice_date <= date_to)

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(
        query.order_by(Invoice.invoice_date.desc(), Invoice.id.desc()).limit(limit).offset(offset)
    ).all()
    return [to_summary(invoice) for invoice in rows], total


# ---------------------------------------------------------------------------
# PDF files
# ---------------------------------------------------------------------------


def pdf_file(invoice: Invoice) -> Path | None:
    if not invoice.pdf_path:
        return None
    path = INVOICE_DIR / invoice.pdf_path
    return path if path.is_file() and _current_layout(path) else None


def _current_layout(path: Path) -> bool:
    """False for a PDF rendered by an older layout, so it is re-rendered instead of served stale."""
    try:
        return PDF_CREATOR.encode() in path.read_bytes()
    except OSError:
        return False


def ensure_pdf(db: Session, invoice: Invoice) -> Path:
    return pdf_file(invoice) or _write_pdf(db, invoice)


def regenerate_pdf(db: Session, invoice: Invoice) -> Path:
    """Re-render the PDF (e.g. after the logo changed). Invoice values are not recalculated."""
    return _write_pdf(db, invoice)


def regenerate_all_pdfs(db: Session) -> None:
    """Re-render every stored PDF so a logo change shows up on existing invoices."""
    for invoice in db.scalars(select(Invoice)):
        try:
            _write_pdf(db, invoice)
        except Exception:
            logger.exception("PDF regeneration failed for invoice %s", invoice.invoice_number)


def _pdf_filename(invoice: Invoice) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", invoice.invoice_number).strip("-") or "invoice"
    if safe != invoice.invoice_number:
        safe = f"{safe}_{invoice.id}"  # keep names unique when sanitising changed the number
    return f"{safe}.pdf"


def _write_pdf(db: Session, invoice: Invoice) -> Path:
    settings = settings_service.get_settings(db)
    filename = _pdf_filename(invoice)
    target = INVOICE_DIR / filename
    generate_invoice_pdf(to_out(invoice), target, logo=settings_service.logo_files(settings), logo_heights=settings_service.logo_heights(settings))
    if invoice.pdf_path != filename:
        invoice.pdf_path = filename
        db.commit()
    return target


def _try_write_pdf(db: Session, invoice: Invoice) -> None:
    # The invoice is already saved; a rendering failure is logged and retried on download.
    try:
        _write_pdf(db, invoice)
    except Exception:
        logger.exception("PDF generation failed for invoice %s", invoice.invoice_number)


def _delete_pdf(invoice: Invoice) -> None:
    existing = pdf_file(invoice)
    if existing:
        existing.unlink(missing_ok=True)
    invoice.pdf_path = None


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------


def customer_display_name(snapshot: dict) -> str:
    return snapshot.get("company_name") or snapshot.get("name") or ""


def to_summary(invoice: Invoice) -> InvoiceSummaryOut:
    return InvoiceSummaryOut(
        id=invoice.id,
        invoice_number=invoice.invoice_number,
        customer_id=invoice.customer_id,
        customer_name=customer_display_name(invoice.customer_snapshot or {}),
        invoice_date=invoice.invoice_date,
        due_date=invoice.due_date,
        grand_total=invoice.grand_total,
        amount_paid=invoice.amount_paid or ZERO,
        balance_due=invoice.balance_due,
        status=invoice.status.value,
    )


def _breakup_from_items(invoice: Invoice) -> list[TaxBreakupOut]:
    buckets: dict[Decimal, TaxBreakupOut] = {}
    for item in invoice.items:
        bucket = buckets.setdefault(
            item.gst_rate,
            TaxBreakupOut(gst_rate=item.gst_rate, taxable_amount=ZERO, cgst=ZERO, sgst=ZERO, igst=ZERO),
        )
        bucket.taxable_amount += item.taxable_amount
        bucket.cgst += item.cgst
        bucket.sgst += item.sgst
        bucket.igst += item.igst
    return [buckets[rate] for rate in sorted(buckets)]


def _product_skus(db: Session | None, invoice: Invoice, items: list[InvoiceItemOut]) -> dict[int, str]:
    ids = {item.product_id for item in items if item.product_id is not None}
    session = db or object_session(invoice)
    if not ids or session is None:
        return {}
    return {pid: sku or "" for pid, sku in session.execute(select(Product.id, Product.sku).where(Product.id.in_(ids)))}


def to_out(invoice: Invoice, db: Session | None = None) -> InvoiceOut:
    items = [InvoiceItemOut.model_validate(item) for item in invoice.items]
    skus = _product_skus(db, invoice, items)
    for item in items:
        if not item.part_no:  # invoices saved before part numbers were stored fall back to the catalogue SKU
            item.part_no = skus.get(item.product_id, "")
    customer = dict(invoice.customer_snapshot or {})
    customer["display_name"] = customer_display_name(customer)
    customer["state_label"] = state_label(customer.get("state_code"))
    business = dict(invoice.business_snapshot or {})
    business["state_label"] = state_label(business.get("state_code"))
    session = db or object_session(invoice)
    live = session.scalar(select(BusinessSettings).limit(1)) if session is not None else None
    for key in ("footer_phone", "footer_whatsapp", "footer_email", "footer_address"):  # letterhead footer always shows the current text
        if live is not None:
            business[key] = getattr(live, key) or ""
    amount_paid = invoice.amount_paid or ZERO
    return InvoiceOut(
        id=invoice.id,
        invoice_number=invoice.invoice_number,
        customer_id=invoice.customer_id,
        invoice_date=invoice.invoice_date,
        due_date=invoice.due_date,
        place_of_supply=invoice.place_of_supply,
        place_of_supply_label=state_label(invoice.place_of_supply),
        is_interstate=invoice.is_interstate,
        payment_terms=invoice.payment_terms or "",
        other_reference=invoice.other_reference or "",
        contact_phone=invoice.contact_phone or "",
        esn=invoice.esn or "",
        subtotal=invoice.subtotal,
        discount=invoice.discount,
        taxable_amount=invoice.taxable_amount,
        cgst=invoice.cgst,
        sgst=invoice.sgst,
        igst=invoice.igst,
        total_tax=invoice.cgst + invoice.sgst + invoice.igst,
        round_off=invoice.round_off,
        grand_total=invoice.grand_total,
        amount_paid=amount_paid,
        balance_due=invoice.grand_total - amount_paid,
        amount_in_words=invoice.amount_in_words,
        status=invoice.status.value,
        notes=invoice.notes or "",
        terms=invoice.terms or "",
        customer=customer,
        business=business,
        items=items,
        tax_breakup=_breakup_from_items(invoice),
        has_pdf=pdf_file(invoice) is not None,
        created_at=invoice.created_at,
    )
