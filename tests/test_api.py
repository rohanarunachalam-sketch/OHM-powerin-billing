"""End-to-end API tests, including the Phase 1 acceptance scenario.

Run from the project root:  python -m pytest -q
"""
from __future__ import annotations

import io
import os
import tempfile
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="billing-test-")
os.environ["BILLING_DATA_DIR"] = _tmp
os.environ["BILLING_INVOICE_DIR"] = str(Path(_tmp) / "invoices")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pypdf import PdfReader  # noqa: E402

from backend.main import app  # noqa: E402
from backend.pdf_generator import format_indian  # noqa: E402
from backend.services.calculations import amount_in_words  # noqa: E402

BUSINESS = {
    "business_name": "Sri Lakshmi Traders",
    "address": "12, Anna Salai\nChennai 600002",
    "phone": "+91 98400 12345",
    "email": "accounts@srilakshmi.example",
    "gstin": "33ABCDE1234F1Z5",
    "pan": "ABCDE1234F",
    "state_code": "33",
    "bank_name": "State Bank of India",
    "account_number": "12345678901",
    "ifsc": "SBIN0001234",
    "upi_id": "srilakshmi@sbi",
    "invoice_prefix": "INV-",
    "invoice_start_number": 1,
    "invoice_terms": "Goods once sold will not be taken back.",
    "invoice_notes": "Thank you for your business!",
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _invoice_payload(customer_id: int, product_id: int | None = None, **overrides) -> dict:
    payload = {
        "customer_id": customer_id,
        "invoice_date": date.today().isoformat(),
        "due_date": (date.today() + timedelta(days=15)).isoformat(),
        "items": [{
            "product_id": product_id,
            "name": "Cement",
            "hsn_sac": "2523",
            "quantity": "10",
            "unit": "Bags",
            "rate": "450",
            "gst_rate": "18",
        }],
    }
    payload.update(overrides)
    return payload


def test_acceptance_flow(client):
    # Business
    r = client.put("/api/settings", json=BUSINESS)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "Tamil Nadu"
    assert r.json()["next_invoice_number"] == "INV-0001"

    # Customer (same state as the business -> CGST + SGST)
    r = client.post("/api/customers", json={
        "name": "ABC Construction",
        "billing_address": "45, Mount Road, Chennai",
        "gstin": "TESTGSTIN123",
        "state_code": "33",
    })
    assert r.status_code == 201, r.text
    customer = r.json()

    # Product
    r = client.post("/api/products", json={
        "name": "Cement", "hsn_sac": "2523", "unit": "Bags", "price": "450", "gst_rate": "18",
    })
    assert r.status_code == 201, r.text
    product = r.json()

    # Preview is calculated on the server and not saved
    r = client.post("/api/invoices/preview", json=_invoice_payload(customer["id"], product["id"]))
    assert r.status_code == 200, r.text
    assert r.json()["id"] is None
    assert client.get("/api/invoices").json()["total"] == 0

    # Invoice — frontend totals are never sent; the server computes them
    r = client.post("/api/invoices", json=_invoice_payload(customer["id"], product["id"]))
    assert r.status_code == 201, r.text
    inv = r.json()
    assert inv["invoice_number"] == "INV-0001"
    assert Decimal(inv["subtotal"]) == Decimal("4500.00")
    assert Decimal(inv["taxable_amount"]) == Decimal("4500.00")
    assert Decimal(inv["cgst"]) == Decimal("405.00")
    assert Decimal(inv["sgst"]) == Decimal("405.00")
    assert Decimal(inv["igst"]) == Decimal("0.00")
    assert Decimal(inv["grand_total"]) == Decimal("5310.00")
    assert inv["amount_in_words"] == "Rupees Five Thousand Three Hundred Ten Only"
    assert inv["is_interstate"] is False
    assert inv["status"] == "Pending"
    assert inv["has_pdf"] is True

    # PDF: true A4 page with the expected content
    r = client.get(f"/api/invoices/{inv['id']}/pdf?download=true")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert 'attachment; filename="INV-0001.pdf"' in r.headers["content-disposition"]
    pdf_path = Path(os.environ["BILLING_INVOICE_DIR"]) / "INV-0001.pdf"
    assert pdf_path.is_file()
    reader = PdfReader(pdf_path)
    box = reader.pages[0].mediabox
    width_mm, height_mm = float(box.width) * 25.4 / 72, float(box.height) * 25.4 / 72
    assert round(width_mm) == 210 and round(height_mm) == 297
    text = " ".join(page.extract_text() for page in reader.pages)
    for expected in (
        "Sri Lakshmi Traders", "33ABCDE1234F1Z5", "Tax Invoice", "INV-0001", "ABC Construction",
        "TESTGSTIN123", "Cement", "2523", "450.00", "18%", "OUTPUT CGST @ 9%", "OUTPUT SGST @ 9%", "Taxable", "Total",
        "405.00", "5,310.00", "INR Five Thousand Three Hundred Ten Only", "State Bank of India",
        "SBIN0001234", "Authorised Signatory", "Declaration", "This is a Computer Generated Invoice",
    ):
        assert expected in text, f"{expected!r} missing from PDF"

    # Next number continues and dashboard reflects real data
    assert client.get("/api/invoices/next-number").json()["invoice_number"] == "INV-0002"
    dash = client.get("/api/dashboard").json()
    assert Decimal(dash["total_sales"]) == Decimal("5310.00")
    assert Decimal(dash["pending"]) == Decimal("5310.00")
    assert dash["invoice_count"] == 1


def test_interstate_igst_discount_and_round_off(client):
    customer = client.post("/api/customers", json={
        "name": "Bengaluru Builders", "company_name": "BB Infra Pvt Ltd", "state_code": "29",
    }).json()
    r = client.post("/api/invoices", json=_invoice_payload(customer["id"], items=[
        {"name": "Consulting", "hsn_sac": "998311", "quantity": "1", "rate": "10000",
         "discount_type": "amount", "discount_value": "500", "gst_rate": "18"},
        {"name": "Steel rod", "quantity": "3.333", "rate": "99.99",
         "discount_type": "percent", "discount_value": "7.5", "gst_rate": "12"},
    ]))
    assert r.status_code == 201, r.text
    inv = r.json()
    assert inv["is_interstate"] is True
    assert Decimal(inv["cgst"]) == Decimal("0") and Decimal(inv["sgst"]) == Decimal("0")
    # 9500 * 18% = 1710 ; 308.27 * 12% = 36.99
    assert Decimal(inv["igst"]) == Decimal("1746.99")
    assert Decimal(inv["taxable_amount"]) == Decimal("9808.27")
    assert Decimal(inv["grand_total"]) == Decimal("11555")
    assert Decimal(inv["round_off"]) == Decimal("-0.26")
    assert inv["customer"]["display_name"] == "BB Infra Pvt Ltd"


def test_duplicate_number_and_validation(client):
    customer_id = client.get("/api/customers").json()["items"][0]["id"]
    r = client.post("/api/invoices", json=_invoice_payload(customer_id, invoice_number="INV-0001"))
    assert r.status_code == 409
    assert "already in use" in r.json()["detail"]

    bad_rate = _invoice_payload(customer_id)
    bad_rate["items"][0]["gst_rate"] = "17"
    r = client.post("/api/invoices", json=bad_rate)
    assert r.status_code == 422 and "GST rate" in r.json()["detail"]

    r = client.post("/api/invoices", json=_invoice_payload(customer_id, items=[]))
    assert r.status_code == 422

    r = client.post("/api/customers", json={"name": "  "})
    assert r.status_code == 422 and "Traceback" not in r.text


def test_status_payments_and_overdue(client):
    customer_id = client.get("/api/customers").json()["items"][0]["id"]
    inv = client.post("/api/invoices", json=_invoice_payload(customer_id)).json()

    r = client.post(f"/api/invoices/{inv['id']}/payments", json={"amount": "1000"})
    assert r.json()["status"] == "Partially Paid"
    r = client.post(f"/api/invoices/{inv['id']}/payments", json={"amount": "99999"})
    assert r.status_code == 422
    r = client.patch(f"/api/invoices/{inv['id']}/status", json={"status": "Paid"})
    assert r.json()["status"] == "Paid" and Decimal(r.json()["balance_due"]) == 0

    past = _invoice_payload(
        customer_id,
        invoice_date=(date.today() - timedelta(days=40)).isoformat(),
        due_date=(date.today() - timedelta(days=10)).isoformat(),
    )
    overdue = client.post("/api/invoices", json=past).json()
    assert overdue["status"] == "Overdue"
    assert client.get("/api/invoices?status=Overdue").json()["total"] >= 1


def test_customer_with_invoices_cannot_be_deleted(client):
    customer_id = client.get("/api/customers?q=ABC").json()["items"][0]["id"]
    r = client.delete(f"/api/customers/{customer_id}")
    assert r.status_code == 409


def test_long_content_paginates(client):
    customer = client.post("/api/customers", json={
        "name": "A very long customer name " * 6,
        "billing_address": "Line of a long address, " * 15,
        "shipping_address": "Different shipping address, " * 8,
        "state_code": "27",
    }).json()
    items = [
        {"name": f"Item {i} <b>&</b>", "description": "Long description text " * 8,
         "hsn_sac": "1234", "quantity": "1", "rate": "123456.78", "gst_rate": "5"}
        for i in range(45)
    ]
    r = client.post("/api/invoices", json=_invoice_payload(customer["id"], items=items))
    assert r.status_code == 201, r.text
    pdf = client.get(f"/api/invoices/{r.json()['id']}/pdf")
    assert pdf.status_code == 200
    reader = PdfReader(io.BytesIO(pdf.content))
    assert len(reader.pages) > 1
    assert "Item 0 <b>&</b>" in reader.pages[0].extract_text()  # markup is escaped, not interpreted


def test_logo_upload_validation_and_pdf(client):
    # Data dir lives outside the project here, which previously broke logo storage.
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (200, 80), (30, 58, 95)).save(buffer, format="PNG")
    r = client.post("/api/settings/logo", files={"file": ("logo.png", buffer.getvalue(), "image/png")})
    assert r.status_code == 200, r.text
    assert r.json()["has_logo"] is True
    assert client.get("/api/settings/logo").status_code == 200

    r = client.post("/api/settings/logo", files={"file": ("evil.png", b"<script>alert(1)</script>", "image/png")})
    assert r.status_code == 400 and "PNG or JPEG" in r.json()["detail"]

    invoice_id = client.get("/api/invoices").json()["items"][0]["id"]
    assert client.post(f"/api/invoices/{invoice_id}/pdf/regenerate").status_code == 200


def test_formatting_helpers():
    assert format_indian(Decimal("245000")) == "2,45,000.00"
    assert format_indian(Decimal("123456789.5")) == "12,34,56,789.50"
    assert format_indian(Decimal("999")) == "999.00"
    assert amount_in_words(Decimal("11210")) == "Rupees Eleven Thousand Two Hundred Ten Only"
    assert amount_in_words(Decimal("2345678")) == (
        "Rupees Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only"
    )


def test_invoice_number_format_and_manual_continuation(client):
    fmt = {**BUSINESS, "invoice_prefix": "OHM", "invoice_suffix": "FY2627", "invoice_digits": 3}
    r = client.put("/api/settings", json=fmt)
    assert r.status_code == 200, r.text
    assert r.json()["next_invoice_number"] == "OHM001FY2627"

    customer_id = client.get("/api/customers").json()["items"][0]["id"]
    r = client.post("/api/invoices", json=_invoice_payload(customer_id, invoice_number="OHM120FY2627"))
    assert r.status_code == 201, r.text
    assert client.get("/api/invoices/next-number").json()["invoice_number"] == "OHM121FY2627"
    r = client.post("/api/invoices", json=_invoice_payload(customer_id))
    assert r.json()["invoice_number"] == "OHM121FY2627"
    assert client.get("/api/invoices/next-number").json()["invoice_number"] == "OHM122FY2627"


def test_reference_fields_default_to_dash_in_pdf(client):
    customer_id = client.get("/api/customers").json()["items"][0]["id"]
    r = client.post("/api/invoices", json=_invoice_payload(customer_id, esn="ESN-778", contact_phone="9876543210"))
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["esn"], body["other_reference"]) == ("ESN-778", "")
    pdf = client.get(f"/api/invoices/{body['id']}/pdf")
    from io import BytesIO
    text = PdfReader(BytesIO(pdf.content)).pages[0].extract_text()
    assert "Other Reference: -" in text and "ESN: ESN-778" in text and "Phone : 9876543210" in text


def test_product_csv_import_and_part_no_on_invoice(client):
    csv_text = (
        "Part No,Description of Goods,HSN/SAC,Unit,Price,GST %\n"
        "P-100,Brake Pad,87083,Nos,\"1,250.50\",28%\n"
        "P-101,Oil Filter,84212300,,300,18\n"
        ",No part number,,,,\n"
    )
    r = client.post("/api/products/import", files={"file": ("parts.csv", csv_text.encode(), "text/csv")})
    assert r.status_code == 200, r.text
    assert (r.json()["created"], r.json()["error_count"]) == (2, 1)
    r = client.post("/api/products/import", files={"file": ("parts.csv", csv_text.replace("300", "310").encode(), "text/csv")})
    assert (r.json()["created"], r.json()["updated"]) == (0, 2)

    pads = next(p for p in client.get("/api/products", params={"q": "P-100"}).json()["items"])
    assert pads["unit"] == "Nos" and pads["price"] == "1250.50" and pads["gst_rate"] == "28.00"

    customer_id = client.get("/api/customers").json()["items"][0]["id"]
    payload = _invoice_payload(customer_id, pads["id"])
    payload["items"][0].update(part_no="P-100-X", name="Brake Pad")  # part no edited by hand
    r = client.post("/api/invoices", json=payload)
    assert r.status_code == 201, r.text
    assert r.json()["items"][0]["part_no"] == "P-100-X"


def test_logo_heights_saved_and_validated(client):
    r = client.put("/api/settings", json={**BUSINESS, "logo_heights": [30, 15, 20]})
    assert r.status_code == 200, r.text
    assert r.json()["logo_heights"] == [30, 15, 20]
    r = client.put("/api/settings", json={**BUSINESS, "logo_heights": [90, 15, 20]})
    assert r.status_code == 422
