from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Customer, Invoice, InvoiceStatus, Product
from ..services import invoice_service, settings_service
from ..services.calculations import ALLOWED_GST_RATES
from ..services.states import GST_STATES

router = APIRouter(prefix="/api", tags=["dashboard"])

_ISSUED = (InvoiceStatus.PENDING, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.PAID, InvoiceStatus.OVERDUE)
ZERO = Decimal("0")
_OPEN = (InvoiceStatus.PENDING, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE)
MAX_RANGE_DAYS = 800


def _sum(db: Session, column, *conditions) -> Decimal:
    return db.scalar(select(func.sum(column)).where(*conditions)) or ZERO


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db)) -> dict:
    invoice_service.refresh_overdue(db)
    issued = Invoice.status.in_(_ISSUED)

    total_sales = _sum(db, Invoice.grand_total, issued)
    paid = _sum(db, Invoice.amount_paid, issued)
    pending = _sum(
        db, Invoice.grand_total, Invoice.status.in_((InvoiceStatus.PENDING, InvoiceStatus.PARTIALLY_PAID))
    ) - _sum(db, Invoice.amount_paid, Invoice.status.in_((InvoiceStatus.PENDING, InvoiceStatus.PARTIALLY_PAID)))
    overdue = _sum(db, Invoice.grand_total, Invoice.status == InvoiceStatus.OVERDUE) - _sum(
        db, Invoice.amount_paid, Invoice.status == InvoiceStatus.OVERDUE
    )

    counts = dict(db.execute(select(Invoice.status, func.count(Invoice.id)).group_by(Invoice.status)).all())
    month_start = date.today().replace(day=1)
    recent = db.scalars(select(Invoice).order_by(Invoice.invoice_date.desc(), Invoice.id.desc()).limit(8)).all()
    settings = settings_service.get_settings(db)

    return {
        "total_sales": total_sales,
        "paid": paid,
        "pending": pending,
        "overdue": overdue,
        "this_month_sales": _sum(db, Invoice.grand_total, issued, Invoice.invoice_date >= month_start),
        "outstanding": pending + overdue,
        "outstanding_count": sum(counts.get(s, 0) for s in _OPEN),
        "pending_count": counts.get(InvoiceStatus.PENDING, 0) + counts.get(InvoiceStatus.PARTIALLY_PAID, 0),
        "paid_percent": float((paid / total_sales * 100).quantize(Decimal("0.1"))) if total_sales else None,
        "invoice_count": sum(count for status, count in counts.items() if status in _ISSUED),
        "draft_count": counts.get(InvoiceStatus.DRAFT, 0),
        "overdue_count": counts.get(InvoiceStatus.OVERDUE, 0),
        "status_counts": {status.value: count for status, count in counts.items()},
        "customer_count": db.scalar(select(func.count(Customer.id))) or 0,
        "product_count": db.scalar(select(func.count(Product.id))) or 0,
        "recent_invoices": [invoice_service.to_summary(i) for i in recent],
        "business_configured": settings_service.is_configured(settings),
        "business_name": settings.business_name,
    }


@router.get("/dashboard/overview")
def overview(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    db: Session = Depends(get_db),
) -> dict:
    """Sales for a date range (default: last 30 days), compared with the previous period of equal length.

    Only issued invoices (pending / partially paid / paid / overdue) count towards sales, exactly as on the dashboard.
    """
    invoice_service.refresh_overdue(db)
    end = date_to or date.today()
    start = date_from or end - timedelta(days=29)
    if start > end:
        start, end = end, start
    days = (end - start).days + 1
    if days > MAX_RANGE_DAYS:
        start, days = end - timedelta(days=MAX_RANGE_DAYS - 1), MAX_RANGE_DAYS
    issued = Invoice.status.in_(_ISSUED)

    def period(a: date, b: date) -> tuple[Decimal, int]:
        row = db.execute(
            select(func.coalesce(func.sum(Invoice.grand_total), 0), func.count(Invoice.id)).where(
                issued, Invoice.invoice_date >= a, Invoice.invoice_date <= b
            )
        ).one()
        return Decimal(row[0]), row[1]

    total, count = period(start, end)
    prev_end = start - timedelta(days=1)
    prev_total, prev_count = period(prev_end - timedelta(days=days - 1), prev_end)

    group = "day" if days <= 62 else "month"
    rows = db.execute(
        select(Invoice.invoice_date, func.sum(Invoice.grand_total))
        .where(issued, Invoice.invoice_date >= start, Invoice.invoice_date <= end)
        .group_by(Invoice.invoice_date)
    ).all()
    buckets: dict[str, Decimal] = {}
    cursor = start
    while cursor <= end:  # every day/month in range appears, even with zero sales
        buckets.setdefault(cursor.isoformat() if group == "day" else cursor.strftime("%Y-%m"), ZERO)
        cursor += timedelta(days=1)
    for day, amount in rows:
        key = day.isoformat() if group == "day" else day.strftime("%Y-%m")
        buckets[key] += amount

    open_invoices = db.scalars(
        select(Invoice)
        .where(Invoice.status.in_(_OPEN))
        .order_by(Invoice.due_date.is_(None), Invoice.due_date, Invoice.invoice_date)
    ).all()
    by_customer: dict[str, dict] = {}
    for inv in open_invoices:
        summary = invoice_service.to_summary(inv)
        entry = by_customer.setdefault(
            summary.customer_name, {"customer_id": summary.customer_id, "name": summary.customer_name, "balance": ZERO, "invoice_count": 0}
        )
        entry["balance"] += summary.balance_due
        entry["invoice_count"] += 1

    return {
        "date_from": start.isoformat(),
        "date_to": end.isoformat(),
        "group": group,
        "total": total,
        "invoice_count": count,
        "previous_total": prev_total,
        "previous_count": prev_count,
        "change_percent": float(((total - prev_total) / prev_total * 100).quantize(Decimal("0.1"))) if prev_total else None,
        "series": [{"label": label, "total": amount} for label, amount in sorted(buckets.items())],
        "outstanding_invoices": [invoice_service.to_summary(i) for i in open_invoices[:6]],
        "outstanding_customers": sorted(by_customer.values(), key=lambda c: c["balance"], reverse=True)[:5],
    }


@router.get("/meta")
def meta() -> dict:
    """Static reference data used by the frontend forms."""
    return {
        "states": [{"code": code, "name": name} for code, name in GST_STATES.items()],
        "gst_rates": [str(rate.normalize()) for rate in ALLOWED_GST_RATES],
        "statuses": [status.value for status in InvoiceStatus],
        "manual_statuses": [status.value for status in invoice_service.MANUAL_STATUSES],
        "units": ["Nos", "Pcs", "Bags", "Box", "Kg", "g", "Ton", "Ltr", "m", "Sq.ft", "Hrs", "Days", "Month", "Job"],
    }
