from __future__ import annotations

from fastapi import APIRouter, Depends, File, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import MAX_LOGO_BYTES
from ..database import get_db
from ..errors import AppError, NotFoundError
from ..schemas import SettingsOut, SettingsUpdate
from ..services import invoice_service, settings_service

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=SettingsOut)
def read_settings(db: Session = Depends(get_db)) -> SettingsOut:
    return settings_service.to_out(db, settings_service.get_settings(db))


@router.put("", response_model=SettingsOut)
def write_settings(payload: SettingsUpdate, db: Session = Depends(get_db)) -> SettingsOut:
    settings = settings_service.update_settings(db, payload)
    if getattr(settings, "logo_sizes_changed", False):
        invoice_service.regenerate_all_pdfs(db)
    return settings_service.to_out(db, settings)


@router.post("/logo", response_model=SettingsOut)
async def upload_logo(slot: int = 1, file: UploadFile = File(...), db: Session = Depends(get_db)) -> SettingsOut:
    content = await file.read(MAX_LOGO_BYTES + 1)
    if len(content) > MAX_LOGO_BYTES:
        raise AppError("Logo must be smaller than 2 MB.")
    settings = settings_service.save_logo(db, content, slot)
    invoice_service.regenerate_all_pdfs(db)
    return settings_service.to_out(db, settings)


@router.delete("/logo", response_model=SettingsOut)
def delete_logo(slot: int = 1, db: Session = Depends(get_db)) -> SettingsOut:
    settings = settings_service.get_settings(db)
    settings_service.remove_logo_file(settings, slot)
    db.commit()
    invoice_service.regenerate_all_pdfs(db)
    return settings_service.to_out(db, settings)


@router.post("/footer-image", response_model=SettingsOut)
async def upload_footer_image(file: UploadFile = File(...), db: Session = Depends(get_db)) -> SettingsOut:
    content = await file.read(MAX_LOGO_BYTES + 1)
    if len(content) > MAX_LOGO_BYTES:
        raise AppError("Footer image must be smaller than 2 MB.")
    settings = settings_service.save_footer_image(db, content)
    invoice_service.regenerate_all_pdfs(db)
    return settings_service.to_out(db, settings)


@router.delete("/footer-image", response_model=SettingsOut)
def delete_footer_image(db: Session = Depends(get_db)) -> SettingsOut:
    settings_service.remove_footer_image()
    invoice_service.regenerate_all_pdfs(db)
    return settings_service.to_out(db, settings_service.get_settings(db))


@router.get("/footer-image")
def get_footer_image() -> Response:
    path = settings_service.footer_image_file()
    if path is None:
        raise NotFoundError("Footer image")
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


@router.get("/logo")
def get_logo(slot: int = 1, db: Session = Depends(get_db)) -> Response:
    path = settings_service.logo_file(settings_service.get_settings(db), slot)
    if path is None:
        raise NotFoundError("Logo")
    return FileResponse(path, headers={"Cache-Control": "no-cache"})
