from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends
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
