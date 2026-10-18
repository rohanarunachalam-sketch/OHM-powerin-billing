"""SQLAlchemy ORM models."""
from __future__ import annotations

import enum
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import JSON, Boolean, Date, DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base, Money, ScaledDecimal


class InvoiceStatus(str, enum.Enum):
    DRAFT = "Draft"
    PENDING = "Pending"
    PARTIALLY_PAID = "Partially Paid"
    PAID = "Paid"
    OVERDUE = "Overdue"
    CANCELLED = "Cancelled"


class DiscountType(str, enum.Enum):
    PERCENT = "percent"
    AMOUNT = "amount"


class BusinessSettings(Base):
    """Single-row table holding the business profile and invoice preferences."""

    __tablename__ = "business_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    business_name: Mapped[str] = mapped_column(String(200), default="")
    address: Mapped[str] = mapped_column(Text, default="")
    phone: Mapped[str] = mapped_column(String(30), default="")
    email: Mapped[str] = mapped_column(String(200), default="")
    gstin: Mapped[str] = mapped_column(String(15), default="")
    pan: Mapped[str] = mapped_column(String(10), default="")
    state: Mapped[str] = mapped_column(String(100), default="")
    state_code: Mapped[str] = mapped_column(String(2), default="")
    bank_name: Mapped[str] = mapped_column(String(200), default="")
    account_name: Mapped[str] = mapped_column(String(200), default="")
    account_number: Mapped[str] = mapped_column(String(40), default="")
    ifsc: Mapped[str] = mapped_column(String(11), default="")
    bank_branch: Mapped[str] = mapped_column(String(200), default="", server_default="")
    upi_id: Mapped[str] = mapped_column(String(100), default="")
    invoice_prefix: Mapped[str] = mapped_column(String(20), default="INV-")
    invoice_suffix: Mapped[str] = mapped_column(String(20), default="", server_default="")
    invoice_digits: Mapped[int] = mapped_column(Integer, default=4, server_default="4")
    invoice_start_number: Mapped[int] = mapped_column(Integer, default=1)
    # Highest sequence number issued so far; never decreases, so numbers are never reused.
    last_invoice_number: Mapped[int] = mapped_column(Integer, default=0)
    default_payment_terms_days: Mapped[int] = mapped_column(Integer, default=15)
    invoice_terms: Mapped[str] = mapped_column(Text, default="")
    invoice_notes: Mapped[str] = mapped_column(Text, default="")
    # Blue letterhead strip at the foot of every invoice page (edited separately from the business profile).
    footer_phone: Mapped[str] = mapped_column(String(100), default="", server_default="")
    footer_whatsapp: Mapped[str] = mapped_column(String(100), default="", server_default="")
    footer_email: Mapped[str] = mapped_column(String(200), default="", server_default="")
    footer_address: Mapped[str] = mapped_column(Text, default="", server_default="")
    # Height in mm of each of the three logos on the invoice header.
    logo_heights: Mapped[list] = mapped_column(JSON, default=lambda: [20, 20, 20], server_default="[20, 20, 20]")
    logo_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    company_name: Mapped[str] = mapped_column(String(200), default="", index=True)
    phone: Mapped[str] = mapped_column(String(30), default="")
    email: Mapped[str] = mapped_column(String(200), default="")
    billing_address: Mapped[str] = mapped_column(Text, default="")
    shipping_address: Mapped[str] = mapped_column(Text, default="")
    gstin: Mapped[str] = mapped_column(String(15), default="", index=True)
    state: Mapped[str] = mapped_column(String(100), default="")
    state_code: Mapped[str] = mapped_column(String(2), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    invoices: Mapped[list[Invoice]] = relationship(back_populates="customer")


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    sku: Mapped[str] = mapped_column(String(64), default="", index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    hsn_sac: Mapped[str] = mapped_column(String(10), default="")
    unit: Mapped[str] = mapped_column(String(20), default="Nos")
    price: Mapped[Decimal] = mapped_column(Money(), default=Decimal("0"))
    gst_rate: Mapped[Decimal] = mapped_column(ScaledDecimal(2), default=Decimal("18"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_number: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id", ondelete="RESTRICT"), index=True)
    invoice_date: Mapped[date] = mapped_column(Date, index=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    place_of_supply: Mapped[str] = mapped_column(String(2))  # GST state code
    is_interstate: Mapped[bool] = mapped_column(Boolean, default=False)
    payment_terms: Mapped[str] = mapped_column(String(100), default="")
    other_reference: Mapped[str] = mapped_column(String(100), default="", server_default="")
    contact_phone: Mapped[str] = mapped_column(String(100), default="", server_default="")
    esn: Mapped[str] = mapped_column(String(100), default="", server_default="")

    subtotal: Mapped[Decimal] = mapped_column(Money())
    discount: Mapped[Decimal] = mapped_column(Money())
    taxable_amount: Mapped[Decimal] = mapped_column(Money())
    cgst: Mapped[Decimal] = mapped_column(Money())
    sgst: Mapped[Decimal] = mapped_column(Money())
    igst: Mapped[Decimal] = mapped_column(Money())
    round_off: Mapped[Decimal] = mapped_column(Money())
    grand_total: Mapped[Decimal] = mapped_column(Money())
    amount_paid: Mapped[Decimal] = mapped_column(Money(), default=Decimal("0"))
    amount_in_words: Mapped[str] = mapped_column(Text)

    status: Mapped[InvoiceStatus] = mapped_column(
        Enum(InvoiceStatus, values_callable=lambda e: [m.value for m in e], native_enum=False, length=20),
        default=InvoiceStatus.PENDING,
        index=True,
    )
    notes: Mapped[str] = mapped_column(Text, default="")
    terms: Mapped[str] = mapped_column(Text, default="")

    # Snapshots keep issued invoices unchanged when the customer or business profile is edited later.
    customer_snapshot: Mapped[dict] = mapped_column(JSON)
    business_snapshot: Mapped[dict] = mapped_column(JSON)

    pdf_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    customer: Mapped[Customer | None] = relationship(back_populates="invoices")
    items: Mapped[list[InvoiceItem]] = relationship(
        back_populates="invoice",
        cascade="all, delete-orphan",
        order_by="InvoiceItem.position",
    )

    @property
    def balance_due(self) -> Decimal:
        return self.grand_total - (self.amount_paid or Decimal("0"))


class InvoiceItem(Base):
    __tablename__ = "invoice_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    part_no: Mapped[str] = mapped_column(String(64), default="", server_default="")
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    hsn_sac: Mapped[str] = mapped_column(String(10), default="")
    quantity: Mapped[Decimal] = mapped_column(ScaledDecimal(3))
    unit: Mapped[str] = mapped_column(String(20), default="")
    rate: Mapped[Decimal] = mapped_column(Money())
    discount_type: Mapped[DiscountType] = mapped_column(
        Enum(DiscountType, values_callable=lambda e: [m.value for m in e], native_enum=False, length=10),
        default=DiscountType.PERCENT,
    )
    discount_value: Mapped[Decimal] = mapped_column(Money(), default=Decimal("0"))
    gross_amount: Mapped[Decimal] = mapped_column(Money())
    discount: Mapped[Decimal] = mapped_column(Money())
    gst_rate: Mapped[Decimal] = mapped_column(ScaledDecimal(2))
    taxable_amount: Mapped[Decimal] = mapped_column(Money())
    cgst: Mapped[Decimal] = mapped_column(Money())
    sgst: Mapped[Decimal] = mapped_column(Money())
    igst: Mapped[Decimal] = mapped_column(Money())
    tax_amount: Mapped[Decimal] = mapped_column(Money())
    amount: Mapped[Decimal] = mapped_column(Money())

    invoice: Mapped[Invoice] = relationship(back_populates="items")
    product: Mapped[Product | None] = relationship()
