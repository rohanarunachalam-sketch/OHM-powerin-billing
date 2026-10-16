from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..schemas import InvoiceIn, InvoiceOut, Page, PaymentIn, StatusUpdate
from ..services import invoice_service as service
from ..services import settings_service

router = APIRouter(prefix="/api/invoices", tags=["invoices"])


@router.get("", response_model=Page)
def list_invoices(
    q: str = Query("", max_length=100),
    status: str = Query("", max_length=20),
    customer_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
) -> Page:
    items, total = service.list_invoices(
        db, q.strip(), status, customer_id, date_from, date_to, limit, offset
    )
    return Page(items=items, total=total)


@router.get("/next-number")
def next_number(db: Session = Depends(get_db)) -> dict:
    number, _ = settings_service.next_invoice_number(db, settings_service.get_settings(db))
    return {"invoice_number": number}


@router.post("/preview", response_model=InvoiceOut)
def preview(payload: InvoiceIn, invoice_id: int | None = None, db: Session = Depends(get_db)) -> InvoiceOut:
    """Server-side calculation of an unsaved invoice (used by the preview screen)."""
    return service.preview_invoice(db, payload, invoice_id)


@router.post("", response_model=InvoiceOut, status_code=201)
def create(payload: InvoiceIn, db: Session = Depends(get_db)) -> InvoiceOut:
    return service.to_out(service.create_invoice(db, payload))


@router.get("/{invoice_id}", response_model=InvoiceOut)
def read(invoice_id: int, db: Session = Depends(get_db)) -> InvoiceOut:
    service.refresh_overdue(db)
    return service.to_out(service.get_invoice(db, invoice_id))


@router.put("/{invoice_id}", response_model=InvoiceOut)
def update(invoice_id: int, payload: InvoiceIn, db: Session = Depends(get_db)) -> InvoiceOut:
    invoice = service.get_invoice(db, invoice_id)
    return service.to_out(service.update_invoice(db, invoice, payload))


@router.patch("/{invoice_id}/status", response_model=InvoiceOut)
def change_status(invoice_id: int, payload: StatusUpdate, db: Session = Depends(get_db)) -> InvoiceOut:
    invoice = service.get_invoice(db, invoice_id)
    return service.to_out(service.set_status(db, invoice, payload.status))


@router.post("/{invoice_id}/payments", response_model=InvoiceOut)
def add_payment(invoice_id: int, payload: PaymentIn, db: Session = Depends(get_db)) -> InvoiceOut:
    invoice = service.get_invoice(db, invoice_id)
    return service.to_out(service.record_payment(db, invoice, payload.amount))


@router.delete("/{invoice_id}", status_code=204)
def delete(invoice_id: int, db: Session = Depends(get_db)) -> Response:
    service.delete_invoice(db, service.get_invoice(db, invoice_id))
    return Response(status_code=204)


@router.get("/{invoice_id}/pdf")
def pdf(invoice_id: int, download: bool = False, db: Session = Depends(get_db)) -> FileResponse:
    invoice = service.get_invoice(db, invoice_id)
    path = service.ensure_pdf(db, invoice)
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=path.name,
        content_disposition_type="attachment" if download else "inline",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/{invoice_id}/pdf/regenerate", response_model=InvoiceOut)
def regenerate_pdf(invoice_id: int, db: Session = Depends(get_db)) -> InvoiceOut:
    invoice = service.get_invoice(db, invoice_id)
    service.regenerate_pdf(db, invoice)
    return service.to_out(invoice)
