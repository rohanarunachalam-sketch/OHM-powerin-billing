from __future__ import annotations

import csv
import io
import re

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..errors import AppError, ConflictError, NotFoundError
from ..models import Product
from ..schemas import Page, ProductCreate, ProductOut, ProductUpdate

router = APIRouter(prefix="/api/products", tags=["products"])


def _get(db: Session, product_id: int) -> Product:
    product = db.get(Product, product_id)
    if product is None:
        raise NotFoundError("Product")
    return product


def _ensure_unique_sku(db: Session, sku: str, exclude_id: int | None = None) -> None:
    if not sku:
        return
    query = select(Product.id).where(func.lower(Product.sku) == sku.lower())
    if exclude_id is not None:
        query = query.where(Product.id != exclude_id)
    if db.scalar(query) is not None:
        raise ConflictError(f"Another product already uses SKU '{sku}'.")


@router.get("", response_model=Page)
def list_products(
    q: str = Query("", max_length=100),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
) -> Page:
    query = select(Product)
    q = q.strip()
    if q:
        pattern = f"%{q}%"
        query = query.where(
            or_(Product.name.ilike(pattern), Product.sku.ilike(pattern), Product.hsn_sac.ilike(pattern))
        )
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    if q:  # exact / prefix Part No matches first, then by name
        order = (
            (func.lower(Product.sku) != q.lower()),
            (~Product.sku.ilike(f"{q}%")),
            func.lower(Product.name),
        )
    else:
        order = (func.lower(Product.name),)
    products = db.scalars(query.order_by(*order).limit(limit).offset(offset)).all()
    return Page(items=[ProductOut.model_validate(p) for p in products], total=total)


@router.post("", response_model=ProductOut, status_code=201)
def create_product(payload: ProductCreate, db: Session = Depends(get_db)) -> Product:
    _ensure_unique_sku(db, payload.sku)
    product = Product(**payload.model_dump())
    db.add(product)
    db.commit()
    return product


_COLUMN_ALIASES = {
    "sku": {"partno", "partnumber", "partcode", "part", "sku", "itemcode", "code"},
    "name": {"descriptionofgoods", "description", "partdescription", "name", "item", "itemname", "product", "goods"},
    "hsn_sac": {"hsnsac", "hsn", "sac", "hsncode"},
    "unit": {"unit", "per", "uom"},
    "price": {"price", "rate", "basic", "unitprice", "amount"},
    "gst_rate": {"gst", "gstrate", "gstpercent", "tax", "taxrate"},
}
MAX_IMPORT_BYTES = 5 * 1024 * 1024


def _field_for(header: str) -> str | None:
    key = re.sub(r"[^a-z]", "", header.lower())
    return next((field for field, names in _COLUMN_ALIASES.items() if key in names), None)


def _cell_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(round(value, 6))
    return str(value).strip()


def _read_xlsx(raw: bytes) -> list[list[str]]:
    try:
        from openpyxl import load_workbook
        sheet = load_workbook(io.BytesIO(raw), read_only=True, data_only=True).worksheets[0]
    except Exception as error:
        raise AppError("Could not read the Excel file.") from error
    rows = [[_cell_text(cell) for cell in row] for row in sheet.iter_rows(values_only=True)]
    return [row for row in rows if any(row)]


def _read_csv(raw: bytes) -> list[list[str]]:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252")
    try:
        dialect = csv.Sniffer().sniff(text[:2048], delimiters=",;	")
    except csv.Error:
        dialect = csv.excel
    return [row for row in csv.reader(io.StringIO(text), dialect) if any(cell.strip() for cell in row)]


@router.post("/import")
async def import_products(file: UploadFile = File(...), db: Session = Depends(get_db)) -> dict:
    """Add or update catalogue items from a CSV (Excel: File > Save As > CSV). Items are matched on Part No."""
    raw = await file.read(MAX_IMPORT_BYTES + 1)
    if len(raw) > MAX_IMPORT_BYTES:
        raise AppError("The file is larger than 5 MB.")
    rows = _read_xlsx(raw) if raw[:2] == b"PK" else _read_csv(raw)
    if not rows:
        raise AppError("The file is empty.")
    fields = [_field_for(header) for header in rows[0]]
    if "sku" not in fields or "name" not in fields:
        raise AppError("The first row must have headings including 'Part No' and 'Description of Goods'.")

    existing = {p.sku.lower(): p for p in db.scalars(select(Product)) if p.sku}
    created = updated = 0
    errors: list[str] = []
    for line, row in enumerate(rows[1:], start=2):
        data: dict = {}
        for field, cell in zip(fields, row):
            if field and field not in data:
                data[field] = cell.strip()
        if data.get("price"):
            data["price"] = f"{float(re.sub(r'[^0-9.]', '', data['price']) or 0):.2f}"
        if data.get("gst_rate"):
            data["gst_rate"] = data["gst_rate"].replace("%", "").strip()
            try:
                if 0 < float(data["gst_rate"]) < 1:  # Excel stores 18% as 0.18
                    data["gst_rate"] = str(round(float(data["gst_rate"]) * 100, 2))
            except ValueError:
                pass
        data = {k: v for k, v in data.items() if v != ""}
        data.setdefault("price", "0")
        try:
            payload = ProductCreate(**data)
        except ValidationError as error:
            first = error.errors()[0]
            errors.append(f"Row {line}: {first['loc'][-1] if first['loc'] else ''} - {first['msg']}")
            continue
        if not payload.sku:
            errors.append(f"Row {line}: Part No is empty.")
            continue
        product = existing.get(payload.sku.lower())
        if product is None:
            product = Product(**payload.model_dump())
            db.add(product)
            existing[payload.sku.lower()] = product
            created += 1
        else:
            for key, value in payload.model_dump().items():
                setattr(product, key, value)
            updated += 1
    db.commit()
    return {"created": created, "updated": updated, "errors": errors[:50], "error_count": len(errors)}


@router.get("/{product_id}", response_model=ProductOut)
def get_product(product_id: int, db: Session = Depends(get_db)) -> Product:
    return _get(db, product_id)


@router.put("/{product_id}", response_model=ProductOut)
def update_product(product_id: int, payload: ProductUpdate, db: Session = Depends(get_db)) -> Product:
    product = _get(db, product_id)
    _ensure_unique_sku(db, payload.sku, exclude_id=product_id)
    for field, value in payload.model_dump().items():
        setattr(product, field, value)
    db.commit()
    return product


@router.delete("/{product_id}", status_code=204)
def delete_product(product_id: int, db: Session = Depends(get_db)) -> Response:
    # Existing invoices keep their own copy of item details, so deletion is safe.
    db.delete(_get(db, product_id))
    db.commit()
    return Response(status_code=204)
