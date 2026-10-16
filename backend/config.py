"""Application configuration, overridable through environment variables."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = Path(os.getenv("BILLING_DATA_DIR", BASE_DIR / "data"))
INVOICE_DIR = Path(os.getenv("BILLING_INVOICE_DIR", BASE_DIR / "invoices"))
UPLOAD_DIR = DATA_DIR / "uploads"
FRONTEND_DIR = BASE_DIR / "frontend"

DATABASE_URL = os.getenv("BILLING_DATABASE_URL", f"sqlite:///{(DATA_DIR / 'billing.db').as_posix()}")

# Optional path to a TTF font containing the ₹ glyph. Auto-detected when unset.
PDF_FONT_PATH = os.getenv("BILLING_PDF_FONT")
PDF_FONT_BOLD_PATH = os.getenv("BILLING_PDF_FONT_BOLD")

MAX_LOGO_BYTES = 2 * 1024 * 1024

LOG_LEVEL = os.getenv("BILLING_LOG_LEVEL", "INFO")

for _directory in (DATA_DIR, INVOICE_DIR, UPLOAD_DIR):
    _directory.mkdir(parents=True, exist_ok=True)
