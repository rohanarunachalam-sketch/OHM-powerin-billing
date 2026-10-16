from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..errors import ConflictError, NotFoundError
from ..models import Customer, Invoice, InvoiceStatus
from ..schemas import CustomerCreate, CustomerOut, CustomerUpdate, Page
from ..services.states import state_name

router = APIRouter(prefix="/api/customers", tags=["customers"])


def _get(db: Session, customer_id: int) -> Customer:
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise NotFoundError("Customer")
    return customer


def _apply(customer: Customer, payload: CustomerCreate) -> None:
    for field, value in payload.model_dump().items():
        setattr(customer, field, value)
    customer.state = state_name(payload.state_code)


def _with_stats(db: Session, customers: list[Customer]) -> list[CustomerOut]:
    if not customers:
        return []
    ids = [c.id for c in customers]
    stats = {
        row.customer_id: (row.count, row.total, row.paid)
        for row in db.execute(
            select(
                Invoice.customer_id,
                func.count(Invoice.id).label("count"),
                func.sum(Invoice.grand_total).label("total"),
                func.sum(Invoice.amount_paid).label("paid"),
            )
            .where(Invoice.customer_id.in_(ids), Invoice.status.notin_([InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED]))
            .group_by(Invoice.customer_id)
        )
    }
    out = []
    for customer in customers:
        count, total, paid = stats.get(customer.id, (0, Decimal("0"), Decimal("0")))
        item = CustomerOut.model_validate(customer)
        item.invoice_count = count
        item.total_billed = total or Decimal("0")
        item.total_paid = paid or Decimal("0")
        item.outstanding = item.total_billed - item.total_paid
        out.append(item)
    return out


@router.get("", response_model=Page)
def list_customers(
    q: str = Query("", max_length=100),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
) -> Page:
    query = select(Customer)
    q = q.strip()
    if q:
        pattern = f"%{q}%"
        query = query.where(
            or_(
                Customer.name.ilike(pattern),
                Customer.company_name.ilike(pattern),
                Customer.gstin.ilike(pattern),
                Customer.phone.ilike(pattern),
                Customer.email.ilike(pattern),
            )
        )
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    customers = db.scalars(query.order_by(func.lower(Customer.name)).limit(limit).offset(offset)).all()
    return Page(items=_with_stats(db, list(customers)), total=total)


@router.post("", response_model=CustomerOut, status_code=201)
def create_customer(payload: CustomerCreate, db: Session = Depends(get_db)) -> CustomerOut:
    customer = Customer()
    _apply(customer, payload)
    db.add(customer)
    db.commit()
    return _with_stats(db, [customer])[0]


@router.get("/{customer_id}", response_model=CustomerOut)
def get_customer(customer_id: int, db: Session = Depends(get_db)) -> CustomerOut:
    return _with_stats(db, [_get(db, customer_id)])[0]


@router.put("/{customer_id}", response_model=CustomerOut)
def update_customer(customer_id: int, payload: CustomerUpdate, db: Session = Depends(get_db)) -> CustomerOut:
    customer = _get(db, customer_id)
    _apply(customer, payload)
    db.commit()
    return _with_stats(db, [customer])[0]


@router.delete("/{customer_id}", status_code=204)
def delete_customer(customer_id: int, db: Session = Depends(get_db)) -> Response:
    customer = _get(db, customer_id)
    invoice_count = db.scalar(select(func.count(Invoice.id)).where(Invoice.customer_id == customer_id))
    if invoice_count:
        raise ConflictError(
            f"This customer has {invoice_count} invoice(s) and cannot be deleted. Delete or reassign the invoices first."
        )
    db.delete(customer)
    db.commit()
    return Response(status_code=204)
