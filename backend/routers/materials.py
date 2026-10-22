"""Material management: stock items, stock in / out and price details. Independent of products and invoices."""
from __future__ import annotations

from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..errors import AppError, ConflictError, NotFoundError
from ..models import Material, StockMovement
from ..schemas import MaterialCreate, MaterialOut, MaterialPage, MaterialUpdate, StockMovementCreate, StockMovementOut

router = APIRouter(prefix="/api/materials", tags=["materials"])

PAISE = Decimal("0.01")


def _get(db: Session, material_id: int) -> Material:
    material = db.get(Material, material_id)
    if material is None:
        raise NotFoundError("Material")
    return material


def _ensure_unique_code(db: Session, code: str, exclude_id: int | None = None) -> None:
    if not code:
        return
    query = select(Material.id).where(func.lower(Material.code) == code.lower())
    if exclude_id is not None:
        query = query.where(Material.id != exclude_id)
    if db.scalar(query) is not None:
        raise ConflictError(f"Another material already uses code '{code}'.")


def _is_low(m: Material) -> bool:
    return m.min_stock > 0 and m.quantity <= m.min_stock


def _out(m: Material) -> MaterialOut:
    out = MaterialOut.model_validate(m)
    out.stock_value = (m.quantity * m.purchase_price).quantize(PAISE, rounding=ROUND_HALF_UP)
    out.is_low = _is_low(m)
    return out


def _record(db: Session, m: Material, kind: str, change: Decimal, when: date | None, unit_price: Decimal | None, note: str) -> None:
    m.quantity = m.quantity + change
    db.add(StockMovement(
        material=m, movement_date=when or date.today(), kind=kind, quantity=change,
        balance=m.quantity, unit_price=unit_price, note=note,
    ))


@router.get("", response_model=MaterialPage)
def list_materials(
    q: str = Query("", max_length=100),
    category: str = Query("", max_length=100),
    low_stock: bool = False,
    db: Session = Depends(get_db),
) -> MaterialPage:
    query = select(Material)
    q = q.strip()
    if q:
        pattern = f"%{q}%"
        query = query.where(or_(
            Material.name.ilike(pattern), Material.code.ilike(pattern),
            Material.category.ilike(pattern), Material.supplier.ilike(pattern), Material.location.ilike(pattern),
        ))
    if category:
        query = query.where(Material.category == category)
    materials = db.scalars(query.order_by(func.lower(Material.name))).all()
    if low_stock:
        materials = [m for m in materials if _is_low(m)]
    items = [_out(m) for m in materials]

    everything = db.scalars(select(Material)).all()  # summary always covers the whole stock, not just the filter
    summary = {
        "count": len(everything),
        "value_at_cost": sum(((m.quantity * m.purchase_price).quantize(PAISE, rounding=ROUND_HALF_UP) for m in everything), Decimal("0")),
        "value_at_selling": sum(((m.quantity * m.selling_price).quantize(PAISE, rounding=ROUND_HALF_UP) for m in everything), Decimal("0")),
        "low_stock": sum(1 for m in everything if _is_low(m)),
        "out_of_stock": sum(1 for m in everything if m.quantity <= 0),
    }
    categories = sorted({m.category for m in everything if m.category}, key=str.lower)
    return MaterialPage(items=items, total=len(items), summary=summary, categories=categories)


@router.post("", response_model=MaterialOut, status_code=201)
def create_material(payload: MaterialCreate, db: Session = Depends(get_db)) -> MaterialOut:
    _ensure_unique_code(db, payload.code)
    data = payload.model_dump(exclude={"opening_stock"})
    material = Material(**data, quantity=Decimal("0"))
    db.add(material)
    if payload.opening_stock > 0:
        _record(db, material, "in", payload.opening_stock, None, payload.purchase_price or None, "Opening stock")
    db.commit()
    return _out(material)


@router.get("/{material_id}", response_model=MaterialOut)
def get_material(material_id: int, db: Session = Depends(get_db)) -> MaterialOut:
    return _out(_get(db, material_id))


@router.put("/{material_id}", response_model=MaterialOut)
def update_material(material_id: int, payload: MaterialUpdate, db: Session = Depends(get_db)) -> MaterialOut:
    material = _get(db, material_id)
    _ensure_unique_code(db, payload.code, exclude_id=material_id)
    for field, value in payload.model_dump().items():
        setattr(material, field, value)
    db.commit()
    return _out(material)


@router.delete("/{material_id}", status_code=204)
def delete_material(material_id: int, db: Session = Depends(get_db)) -> Response:
    db.delete(_get(db, material_id))
    db.commit()
    return Response(status_code=204)


@router.post("/{material_id}/stock", response_model=MaterialOut)
def move_stock(material_id: int, payload: StockMovementCreate, db: Session = Depends(get_db)) -> MaterialOut:
    material = _get(db, material_id)
    if payload.kind == "set":
        change = payload.quantity - material.quantity
        note = payload.note or "Stock count"
    else:
        if payload.quantity <= 0:
            raise AppError("Quantity must be more than 0.")
        change = payload.quantity if payload.kind == "in" else -payload.quantity
        note = payload.note
        if material.quantity + change < 0:
            raise AppError(f"Only {material.quantity.normalize():f} {material.unit} in stock; cannot take out {payload.quantity.normalize():f}.")
    _record(db, material, payload.kind, change, payload.movement_date, payload.unit_price, note)
    if payload.kind == "in" and payload.unit_price:
        material.purchase_price = payload.unit_price  # latest purchase price
    db.commit()
    return _out(material)


@router.get("/{material_id}/movements", response_model=list[StockMovementOut])
def list_movements(material_id: int, db: Session = Depends(get_db)) -> list[StockMovement]:
    _get(db, material_id)
    return list(db.scalars(
        select(StockMovement).where(StockMovement.material_id == material_id).order_by(StockMovement.id.desc()).limit(500)
    ))
