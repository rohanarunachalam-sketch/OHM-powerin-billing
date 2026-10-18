"""Database engine, session factory and custom column types."""
from __future__ import annotations

from collections.abc import Iterator
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import Integer, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from .config import DATABASE_URL

_is_sqlite = DATABASE_URL.startswith("sqlite")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
)

if _is_sqlite:

    @event.listens_for(engine, "connect")
    def _enable_sqlite_foreign_keys(dbapi_connection, _record) -> None:  # pragma: no cover - driver hook
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class ScaledDecimal(TypeDecorator):
    """Stores a Decimal as a scaled integer (e.g. rupees as paise).

    SQLite has no native decimal type; storing integers keeps money exact and
    still allows SUM() aggregation in SQL.
    """

    impl = Integer
    cache_ok = True

    def __init__(self, places: int = 2) -> None:
        super().__init__()
        self.places = places
        self._factor = Decimal(10) ** places
        self._quantum = Decimal(1).scaleb(-places)

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        scaled = (Decimal(str(value)) * self._factor).quantize(Decimal(1), rounding=ROUND_HALF_UP)
        return int(scaled)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return (Decimal(int(value)) / self._factor).quantize(self._quantum)


def Money() -> ScaledDecimal:  # noqa: N802 - reads like a column type
    return ScaledDecimal(2)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from . import models  # noqa: F401 - register models

    Base.metadata.create_all(bind=engine)
    _add_missing_columns()


def _add_missing_columns() -> None:
    """Tiny forward-only migration: add columns introduced after a database was first created."""
    from sqlalchemy import inspect, text

    wanted = {
        "business_settings": {
            "invoice_suffix": "VARCHAR(20) NOT NULL DEFAULT ''",
            "invoice_digits": "INTEGER NOT NULL DEFAULT 4",
            "bank_branch": "VARCHAR(200) NOT NULL DEFAULT ''",
            "logo_heights": "JSON NOT NULL DEFAULT '[20, 20, 20]'",
        },
    }
    wanted["business_settings"].update({
        "footer_phone": "VARCHAR(100) NOT NULL DEFAULT ''",
        "footer_whatsapp": "VARCHAR(100) NOT NULL DEFAULT ''",
        "footer_email": "VARCHAR(200) NOT NULL DEFAULT ''",
        "footer_address": "TEXT NOT NULL DEFAULT ''",
    })
    wanted["invoice_items"] = {"part_no": "VARCHAR(64) NOT NULL DEFAULT ''"}
    wanted["invoices"] = {name: "VARCHAR(100) NOT NULL DEFAULT ''" for name in ("other_reference", "contact_phone", "esn")}
    inspector = inspect(engine)
    cols = {c["name"] for c in inspector.get_columns("business_settings")}
    first_footer = "footer_phone" not in cols
    first_whatsapp = "footer_whatsapp" not in cols
    with engine.begin() as conn:
        for table, columns in wanted.items():
            existing = {c["name"] for c in inspector.get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
        if first_footer:  # start the letterhead footer from the existing business details
            conn.execute(text(
                "UPDATE business_settings SET footer_phone = phone, footer_email = email, footer_address = address"
            ))
        if first_whatsapp:  # WhatsApp starts as the same number as the call number
            conn.execute(text("UPDATE business_settings SET footer_whatsapp = footer_phone"))
