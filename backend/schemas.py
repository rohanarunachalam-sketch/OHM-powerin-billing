"""Pydantic request/response schemas.

Monetary values are serialised as strings (e.g. "450.00") so no precision is lost
between the backend and the browser.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator
from pydantic.functional_validators import BeforeValidator

from .models import InvoiceStatus
from .services.calculations import ALLOWED_GST_RATES, amount_in_words
from .services.states import GST_STATES

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_GSTIN_CHARS = re.compile(r"^[0-9A-Z]{1,15}$")
_PHONE = re.compile(r"^[0-9+()\-\s]{6,20}$")
_PAN = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
_IFSC = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _clean_text(value: object) -> object:
    """Trim, normalise and strip control characters from user-entered text."""
    if value is None:
        return ""
    if isinstance(value, str):
        value = unicodedata.normalize("NFC", value)
        value = _CONTROL_CHARS.sub("", value.replace("\r\n", "\n"))
        return value.strip()
    return value


def _short(max_length: int) -> type[str]:
    return Annotated[str, BeforeValidator(_clean_text), Field(max_length=max_length)]  # type: ignore[return-value]


def _validate_state_code(code: str) -> str:
    if code and code not in GST_STATES:
        raise ValueError("Unknown GST state code.")
    return code


def _validate_gstin(value: str) -> str:
    value = value.upper().replace(" ", "")
    if value and not _GSTIN_CHARS.match(value):
        raise ValueError("GSTIN may contain only letters and digits (max 15).")
    return value


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------


class CustomerBase(BaseModel):
    name: _short(200) = Field(min_length=1)
    company_name: _short(200) = ""
    phone: _short(30) = ""
    email: _short(200) = ""
    billing_address: _short(1000) = ""
    shipping_address: _short(1000) = ""
    gstin: _short(15) = ""
    state_code: _short(2) = ""
    notes: _short(2000) = ""

    @field_validator("name")
    @classmethod
    def _name_required(cls, v: str) -> str:
        if not v:
            raise ValueError("Customer name is required.")
        return v

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v: str) -> str:
        return _validate_gstin(v)

    @field_validator("state_code")
    @classmethod
    def _state(cls, v: str) -> str:
        return _validate_state_code(v)

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        if v and not _PHONE.match(v):
            raise ValueError("Enter a valid phone number.")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        if v and not _EMAIL.match(v):
            raise ValueError("Enter a valid email address.")
        return v

    @model_validator(mode="after")
    def _derive_state_from_gstin(self) -> CustomerBase:
        # A standard GSTIN starts with the 2-digit state code.
        if not self.state_code and len(self.gstin) == 15 and self.gstin[:2] in GST_STATES:
            self.state_code = self.gstin[:2]
        return self


class CustomerCreate(CustomerBase):
    pass


class CustomerUpdate(CustomerBase):
    pass


class CustomerOut(ORMModel):
    id: int
    name: str
    company_name: str
    phone: str
    email: str
    billing_address: str
    shipping_address: str
    gstin: str
    state: str
    state_code: str
    notes: str
    created_at: datetime | None
    invoice_count: int = 0
    total_billed: Decimal = Decimal("0")
    total_paid: Decimal = Decimal("0")
    outstanding: Decimal = Decimal("0")


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------

GstRate = Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)]


def _validate_gst_rate(v: Decimal) -> Decimal:
    if v not in ALLOWED_GST_RATES:
        allowed = ", ".join(f"{r.normalize()}%" for r in ALLOWED_GST_RATES)
        raise ValueError(f"GST rate must be one of {allowed}.")
    return v


class ProductBase(BaseModel):
    name: _short(200) = Field(min_length=1)
    sku: _short(64) = ""
    description: _short(1000) = ""
    hsn_sac: _short(10) = ""
    unit: _short(20) = "Nos"
    price: Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2)]
    gst_rate: GstRate = Decimal("18")

    @field_validator("hsn_sac")
    @classmethod
    def _hsn(cls, v: str) -> str:
        if v and not v.isdigit():
            raise ValueError("HSN/SAC code must contain digits only.")
        return v

    @field_validator("gst_rate")
    @classmethod
    def _rate(cls, v: Decimal) -> Decimal:
        return _validate_gst_rate(v)

    @field_validator("unit")
    @classmethod
    def _unit(cls, v: str) -> str:
        return v or "Nos"


class ProductCreate(ProductBase):
    pass


class ProductUpdate(ProductBase):
    pass


class ProductOut(ORMModel):
    id: int
    name: str
    sku: str
    description: str
    hsn_sac: str
    unit: str
    price: Decimal
    gst_rate: Decimal
    created_at: datetime | None


# ---------------------------------------------------------------------------
# Business settings
# ---------------------------------------------------------------------------


class SettingsUpdate(BaseModel):
    business_name: _short(200) = Field(min_length=1)
    address: _short(1000) = ""
    phone: _short(30) = ""
    email: _short(200) = ""
    gstin: _short(15) = ""
    pan: _short(10) = ""
    state_code: _short(2) = Field(min_length=2)
    bank_name: _short(200) = ""
    account_name: _short(200) = ""
    account_number: _short(40) = ""
    ifsc: _short(11) = ""
    upi_id: _short(100) = ""
    invoice_prefix: _short(20) = "INV-"
    invoice_suffix: _short(20) = ""
    invoice_digits: int = Field(default=4, ge=1, le=8)
    invoice_start_number: int = Field(default=1, ge=1, le=99_999_999)
    default_payment_terms_days: int = Field(default=15, ge=0, le=365)
    invoice_terms: _short(3000) = ""
    invoice_notes: _short(2000) = ""
    footer_phone: _short(100) = ""
    footer_whatsapp: _short(100) = ""
    footer_email: _short(200) = ""
    footer_address: _short(500) = ""
    logo_heights: list[int] = Field(default=[20, 20, 20], min_length=3, max_length=3)

    @field_validator("logo_heights")
    @classmethod
    def _logo_heights(cls, v: list[int]) -> list[int]:
        if any(not 8 <= h <= 40 for h in v):
            raise ValueError("Logo size must be between 8 mm and 40 mm.")
        return v

    @field_validator("business_name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not v:
            raise ValueError("Business name is required.")
        return v

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v: str) -> str:
        return _validate_gstin(v)

    @field_validator("state_code")
    @classmethod
    def _state(cls, v: str) -> str:
        if not v:
            raise ValueError("Business state is required for GST calculation.")
        return _validate_state_code(v)

    @field_validator("pan")
    @classmethod
    def _pan(cls, v: str) -> str:
        v = v.upper()
        if v and not _PAN.match(v):
            raise ValueError("PAN must look like ABCDE1234F.")
        return v

    @field_validator("ifsc")
    @classmethod
    def _ifsc(cls, v: str) -> str:
        v = v.upper()
        if v and not _IFSC.match(v):
            raise ValueError("IFSC must look like SBIN0001234.")
        return v

    @field_validator("account_number")
    @classmethod
    def _account(cls, v: str) -> str:
        v = v.replace(" ", "")
        if v and not v.isalnum():
            raise ValueError("Account number may contain only letters and digits.")
        return v

    @field_validator("invoice_prefix", "invoice_suffix")
    @classmethod
    def _prefix(cls, v: str) -> str:
        if not re.match(r"^[A-Za-z0-9/\-_]*$", v):
            raise ValueError("Invoice prefix and suffix may contain letters, digits, '/', '-' and '_'.")
        return v


class SettingsOut(ORMModel):
    business_name: str
    address: str
    phone: str
    email: str
    gstin: str
    pan: str
    state: str
    state_code: str
    bank_name: str
    account_name: str
    account_number: str
    ifsc: str
    upi_id: str
    invoice_prefix: str
    invoice_suffix: str
    invoice_digits: int
    invoice_start_number: int
    default_payment_terms_days: int
    invoice_terms: str
    invoice_notes: str
    footer_phone: str
    footer_whatsapp: str
    footer_email: str
    footer_address: str
    logo_heights: list[int] = [20, 20, 20]
    has_logo: bool
    logos: list[bool] = []  # which of the logo slots have an image
    is_configured: bool
    next_invoice_number: str


# ---------------------------------------------------------------------------
# Invoices
# ---------------------------------------------------------------------------


class InvoiceItemIn(BaseModel):
    product_id: int | None = None
    part_no: _short(64) = ""
    name: _short(200) = Field(min_length=1)
    description: _short(1000) = ""
    hsn_sac: _short(10) = ""
    quantity: Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=3)]
    unit: _short(20) = ""
    rate: Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2)]
    discount_type: Literal["percent", "amount"] = "percent"
    discount_value: Annotated[Decimal, Field(ge=0, max_digits=14, decimal_places=2)] = Decimal("0")
    gst_rate: GstRate

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not v:
            raise ValueError("Item name is required.")
        return v

    @field_validator("gst_rate")
    @classmethod
    def _rate(cls, v: Decimal) -> Decimal:
        return _validate_gst_rate(v)


EditableStatus = Literal["Draft", "Pending"]


class InvoiceIn(BaseModel):
    customer_id: int
    invoice_number: _short(40) = ""
    invoice_date: date
    due_date: date | None = None
    place_of_supply: _short(2) = ""
    payment_terms: _short(100) = ""
    other_reference: _short(100) = ""
    contact_phone: _short(100) = ""
    esn: _short(100) = ""
    status: EditableStatus = "Pending"
    notes: _short(2000) = ""
    terms: _short(3000) = ""
    items: list[InvoiceItemIn] = Field(min_length=1, max_length=200)

    @field_validator("place_of_supply")
    @classmethod
    def _pos(cls, v: str) -> str:
        return _validate_state_code(v)

    @field_validator("invoice_number")
    @classmethod
    def _number(cls, v: str) -> str:
        if v and not re.match(r"^[A-Za-z0-9/\-_]+$", v):
            raise ValueError("Invoice number may contain letters, digits, '/', '-' and '_'.")
        return v

    @model_validator(mode="after")
    def _dates(self) -> InvoiceIn:
        if self.due_date and self.due_date < self.invoice_date:
            raise ValueError("Due date cannot be before the invoice date.")
        return self


class StatusUpdate(BaseModel):
    status: InvoiceStatus


class PaymentIn(BaseModel):
    amount: Annotated[Decimal, Field(gt=0, max_digits=14, decimal_places=2)]


class InvoiceItemOut(ORMModel):
    id: int | None = None
    product_id: int | None
    part_no: str = ""  # the product's SKU, shown as "Part No" on the invoice
    name: str
    description: str
    hsn_sac: str
    quantity: Decimal
    unit: str
    rate: Decimal
    discount_type: str
    discount_value: Decimal
    gross_amount: Decimal
    discount: Decimal
    gst_rate: Decimal
    taxable_amount: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal
    tax_amount: Decimal
    amount: Decimal

    @field_validator("discount_type", mode="before")
    @classmethod
    def _enum_value(cls, v: object) -> object:
        return getattr(v, "value", v)


class TaxBreakupOut(BaseModel):
    gst_rate: Decimal
    taxable_amount: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal


class InvoiceSummaryOut(BaseModel):
    id: int
    invoice_number: str
    customer_id: int | None
    customer_name: str
    invoice_date: date
    due_date: date | None
    grand_total: Decimal
    amount_paid: Decimal
    balance_due: Decimal
    status: str


class InvoiceOut(BaseModel):
    """Full invoice; also used for unsaved previews (id is then None)."""

    id: int | None
    invoice_number: str
    customer_id: int | None
    invoice_date: date
    due_date: date | None
    place_of_supply: str
    place_of_supply_label: str
    is_interstate: bool
    payment_terms: str
    other_reference: str = ""
    contact_phone: str = ""
    esn: str = ""
    subtotal: Decimal
    discount: Decimal
    taxable_amount: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal
    total_tax: Decimal
    round_off: Decimal
    grand_total: Decimal
    amount_paid: Decimal
    balance_due: Decimal
    amount_in_words: str
    status: str
    notes: str
    terms: str
    customer: dict
    business: dict
    items: list[InvoiceItemOut]
    tax_breakup: list[TaxBreakupOut]
    has_pdf: bool = False
    created_at: datetime | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def tax_amount_in_words(self) -> str:
        return amount_in_words(self.total_tax) if self.total_tax > 0 else ""


class Page(BaseModel):
    items: list
    total: int

