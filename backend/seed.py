"""Optional demo data.  Run from the project root:  python -m backend.seed

Only fills an empty database; it never touches existing records.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func, select

from .database import SessionLocal, init_db
from .models import Customer, Invoice, Product
from .schemas import CustomerCreate, InvoiceIn, ProductCreate, SettingsUpdate
from .services import invoice_service, settings_service
from .services.states import state_name


def seed() -> None:
    init_db()
    with SessionLocal() as db:
        if db.scalar(select(func.count(Invoice.id))) or db.scalar(select(func.count(Customer.id))):
            print("Database already has data; seed skipped.")
            return

        settings = settings_service.get_settings(db)
        if not settings_service.is_configured(settings):
            settings_service.update_settings(db, SettingsUpdate(
                business_name="Demo Building Supplies",
                address="12, Anna Salai\nChennai 600002",
                phone="+91 98400 12345",
                email="accounts@demo-supplies.example",
                gstin="33ABCDE1234F1Z5",
                pan="ABCDE1234F",
                state_code="33",
                bank_name="State Bank of India",
                account_number="12345678901",
                ifsc="SBIN0001234",
                upi_id="demosupplies@sbi",
                invoice_terms="1. Goods once sold will not be taken back.\n2. Interest @18% p.a. on overdue payments.",
                invoice_notes="Thank you for your business!",
            ))

        customers = []
        for data in (
            CustomerCreate(name="ABC Construction", billing_address="45, Mount Road, Chennai", gstin="33AAACA1234B1Z2", state_code="33"),
            CustomerCreate(name="Ravi Kumar", company_name="Bengaluru Infra Pvt Ltd", billing_address="7, MG Road, Bengaluru", gstin="29AABCB5678C1Z4", state_code="29"),
        ):
            customer = Customer(**data.model_dump(), state=state_name(data.state_code))
            db.add(customer)
            customers.append(customer)

        products = []
        for data in (
            ProductCreate(name="Cement (50 kg bag)", sku="CEM-50", hsn_sac="2523", unit="Bags", price="450", gst_rate="18"),
            ProductCreate(name="TMT Steel Bar 12mm", sku="TMT-12", hsn_sac="7214", unit="Kg", price="68.50", gst_rate="18"),
            ProductCreate(name="Site consultation", sku="SRV-CON", hsn_sac="998311", unit="Hrs", price="1500", gst_rate="18"),
        ):
            product = Product(**data.model_dump())
            db.add(product)
            products.append(product)
        db.commit()

        today = date.today()
        for customer, product, qty, days_ago in (
            (customers[0], products[0], "10", 3),
            (customers[1], products[1], "250", 40),
        ):
            invoice_service.create_invoice(db, InvoiceIn(
                customer_id=customer.id,
                invoice_date=today - timedelta(days=days_ago),
                due_date=today - timedelta(days=days_ago) + timedelta(days=15),
                payment_terms="Net 15",
                items=[{
                    "product_id": product.id, "name": product.name, "hsn_sac": product.hsn_sac,
                    "quantity": qty, "unit": product.unit, "rate": product.price, "gst_rate": product.gst_rate,
                }],
            ))
        print("Demo data created: 2 customers, 3 products, 2 invoices.")


if __name__ == "__main__":
    seed()
