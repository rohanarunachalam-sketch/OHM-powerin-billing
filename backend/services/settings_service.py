"""Business settings persistence and invoice numbering."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import MAX_LOGO_BYTES, UPLOAD_DIR
from ..errors import AppError
from ..models import BusinessSettings, Invoice
from ..schemas import SettingsOut, SettingsUpdate
from .states import state_name

LOGO_TYPES = {
    b"\x89PNG\r\n\x1a\n": ".png",
    b"\xff\xd8\xff": ".jpg",
}


def get_settings(db: Session) -> BusinessSettings:
    settings = db.scalar(select(BusinessSettings).limit(1))
    if settings is None:
        settings = BusinessSettings(
            invoice_prefix="INV-",
            invoice_start_number=1,
            last_invoice_number=0,
            default_payment_terms_days=15,
            invoice_terms="1. Goods once sold will not be taken back.\n2. Interest @18% p.a. will be charged on overdue payments.",
            invoice_notes="Thank you for your business!",
        )
        db.add(settings)
        db.commit()
    return settings


def is_configured(settings: BusinessSettings) -> bool:
    return bool(settings.business_name and settings.state_code)


def format_invoice_number(prefix: str, sequence: int, suffix: str = "", digits: int = 4) -> str:
    return f"{prefix}{sequence:0{digits}d}{suffix}"


def parse_sequence(number: str, prefix: str, suffix: str = "") -> int | None:
    """The running number inside e.g. OHM132FY2627, or None if the number doesn't use this format."""
    if not number.startswith(prefix) or not number.endswith(suffix) or len(number) <= len(prefix) + len(suffix):
        return None
    middle = number[len(prefix):len(number) - len(suffix)]
    return int(middle) if middle.isdigit() else None


def next_sequence(settings: BusinessSettings) -> int:
    return max(settings.invoice_start_number, settings.last_invoice_number + 1)


def next_invoice_number(db: Session, settings: BusinessSettings) -> tuple[str, int]:
    """Next unused invoice number. Skips numbers already taken (e.g. entered manually)."""
    sequence = next_sequence(settings)
    while True:
        number = format_invoice_number(settings.invoice_prefix, sequence, settings.invoice_suffix, settings.invoice_digits)
        if db.scalar(select(Invoice.id).where(Invoice.invoice_number == number)) is None:
            return number, sequence
        sequence += 1


LOGO_SLOTS = (1, 2, 3)  # slot 1 is stored in settings.logo_path; slots 2-3 are files named logo2.* / logo3.*


def logo_file(settings: BusinessSettings, slot: int = 1) -> Path | None:
    if slot == 1:
        if not settings.logo_path:
            return None
        path = UPLOAD_DIR / Path(settings.logo_path).name  # stored as a bare file name
        return path if path.is_file() else None
    candidates = (UPLOAD_DIR / f"logo{slot}{ext}" for ext in LOGO_TYPES.values())
    return next((path for path in candidates if path.is_file()), None)


def logo_files(settings: BusinessSettings) -> list[Path]:
    """All uploaded logos in slot order (used for the invoice header)."""
    return [path for slot in LOGO_SLOTS if (path := logo_file(settings, slot))]


def logo_heights(settings: BusinessSettings) -> list[float]:
    """Heights (mm) of the uploaded logos, in the same order as logo_files()."""
    sizes = list(settings.logo_heights or [20, 20, 20])
    sizes += [20] * (len(LOGO_SLOTS) - len(sizes))
    return [float(sizes[slot - 1]) for slot in LOGO_SLOTS if logo_file(settings, slot)]


def to_out(db: Session, settings: BusinessSettings) -> SettingsOut:
    number, _ = next_invoice_number(db, settings)
    return SettingsOut(
        **{field: getattr(settings, field) for field in SettingsUpdate.model_fields},
        state=settings.state,
        has_logo=logo_file(settings) is not None,
        logos=[logo_file(settings, slot) is not None for slot in LOGO_SLOTS],
        is_configured=is_configured(settings),
        next_invoice_number=number,
    )


def update_settings(db: Session, payload: SettingsUpdate) -> BusinessSettings:
    settings = get_settings(db)
    sizes_changed = list(settings.logo_heights or []) != list(payload.logo_heights) or any(
        getattr(settings, f) != getattr(payload, f) for f in ("footer_phone", "footer_whatsapp", "footer_email", "footer_address")
    )  # either one changes how every stored PDF looks
    format_changed = (settings.invoice_prefix, settings.invoice_suffix) != (payload.invoice_prefix, payload.invoice_suffix)
    for field, value in payload.model_dump().items():
        setattr(settings, field, value)
    settings.state = state_name(payload.state_code)
    if format_changed:
        # A new prefix/suffix starts its own series: continue after the highest number already in that format.
        used = (
            parse_sequence(number, settings.invoice_prefix, settings.invoice_suffix)
            for number in db.scalars(select(Invoice.invoice_number))
        )
        settings.last_invoice_number = max((n for n in used if n is not None), default=0)
    db.commit()
    settings.logo_sizes_changed = sizes_changed  # lets the router refresh stored PDFs
    return settings


def save_logo(db: Session, content: bytes, slot: int = 1) -> BusinessSettings:
    if not content:
        raise AppError("The uploaded file is empty.")
    if len(content) > MAX_LOGO_BYTES:
        raise AppError("Logo must be smaller than 2 MB.")
    extension = next((ext for magic, ext in LOGO_TYPES.items() if content.startswith(magic)), None)
    if extension is None:
        raise AppError("Logo must be a PNG or JPEG image.")

    _check_slot(slot)
    settings = get_settings(db)
    remove_logo_file(settings, slot)
    target = UPLOAD_DIR / (f"logo{extension}" if slot == 1 else f"logo{slot}{extension}")
    target.write_bytes(content)
    if slot == 1:
        settings.logo_path = target.name
    db.commit()
    return settings


def _check_slot(slot: int) -> None:
    if slot not in LOGO_SLOTS:
        raise AppError(f"Logo slot must be one of {', '.join(map(str, LOGO_SLOTS))}.")


def remove_logo_file(settings: BusinessSettings, slot: int = 1) -> None:
    _check_slot(slot)
    existing = logo_file(settings, slot)
    if existing:
        existing.unlink(missing_ok=True)
    if slot == 1:
        settings.logo_path = None


def business_snapshot(settings: BusinessSettings) -> dict:
    fields = (
        "business_name", "address", "phone", "email", "gstin", "pan", "state", "state_code",
        "bank_name", "account_name", "account_number", "ifsc", "upi_id",
    )
    return {field: getattr(settings, field) or "" for field in fields}
