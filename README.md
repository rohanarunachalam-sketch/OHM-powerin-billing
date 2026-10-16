# Billing — GST Invoicing for Indian Businesses

A clean, self-hosted billing and invoicing web application for small and medium
businesses in India. Create customers and products, raise GST-compliant tax
invoices with automatic CGST/SGST or IGST, preview them, and download true **A4 PDF**
invoices — all stored in a local SQLite database.

Backend: **FastAPI + SQLAlchemy + Pydantic + ReportLab**. Frontend: **HTML, CSS and
vanilla JavaScript** (ES modules, no framework, no build step).

---

## Features (Phase 1)

| Area | What you get |
|---|---|
| **Dashboard** | Total sales, paid, pending, overdue, invoice count, receivables bar, recent invoices, setup checklist — all from live data |
| **Customers** | Add / edit / delete / view / search (name, company, GSTIN, phone, email). State auto-filled from GSTIN. Customers with invoices are protected from deletion |
| **Products & Services** | Add / edit / delete / search (name, SKU, HSN/SAC), unit, price, GST slab |
| **Business settings** | Profile, logo upload (PNG/JPEG), GSTIN, PAN, state, bank & UPI, invoice prefix / starting number, default terms & notes |
| **Invoice creation** | Searchable customer picker (or create inline), auto invoice number, dates & payment terms, place of supply, dynamic item rows with product autocomplete, % or ₹ discount per line, live totals |
| **GST** | Same state → CGST + SGST; different state → IGST. Per-rate tax breakup, round-off to the nearest rupee, amount in words (Indian Lakh/Crore) |
| **Preview** | Server-calculated preview that mirrors the PDF before anything is saved |
| **A4 PDF** | Real ReportLab document (210 × 297 mm) saved to `invoices/INV-0001.pdf`, downloadable from the browser |
| **Status & payments** | Draft, Pending, Partially Paid, Paid, Overdue (automatic from due date), Cancelled. Record partial payments or mark as paid |
| **Invoice history** | Search by number/customer, filter by status and date range |

### Correctness guarantees

* **The server is the source of truth.** The browser never sends totals; the backend
  recalculates every line and total from quantities, rates, discounts and GST rates.
* **No floating point.** Python uses `Decimal` (half-up rounding to paise). Money is stored
  in SQLite as integer paise. The browser's live preview uses `BigInt` with the same
  rounding rules — fuzz-tested against the backend on 3,000 random invoices with zero
  differences.
* **Unique, never-reused invoice numbers.** A monotonic counter plus a database unique
  constraint; a deleted invoice's number is not handed out again.
* **Issued invoices don't change.** Each invoice stores a snapshot of the customer and
  business details at the time of issue.

---

## Project structure

```text
billing-software/
├── backend/
│   ├── __init__.py
│   ├── main.py               # FastAPI app, middleware, static frontend
│   ├── config.py             # paths & env configuration
│   ├── database.py           # engine, session, exact Decimal column type
│   ├── models.py             # SQLAlchemy models
│   ├── schemas.py            # Pydantic validation / response schemas
│   ├── errors.py             # friendly error responses, server-side logging
│   ├── pdf_generator.py      # ReportLab A4 invoice
│   ├── seed.py               # optional demo data
│   ├── routers/              # REST endpoints
│   │   ├── dashboard.py  customers.py  products.py  invoices.py  settings.py
│   └── services/
│       ├── calculations.py   # GST maths, round-off, amount in words
│       ├── invoice_service.py# numbering, persistence, status, PDF files
│       ├── settings_service.py
│       └── states.py         # Indian GST state codes
├── frontend/
│   ├── index.html  style.css  doc.css  app.js   # shell, design system, invoice preview styles, router
│   └── js/
│       ├── api.js  ui.js  utils.js  store.js  icons.js
│       └── views/            # dashboard, invoices, invoice-form, invoice-view,
│                             # invoice-doc, customers, products, payments,
│                             # reports, settings, forms
├── invoices/                 # generated PDFs
├── data/                     # SQLite database + uploaded logo (created on first run)
├── tests/test_api.py         # API + acceptance tests
├── requirements.txt
└── requirements-dev.txt
```

---

## Installation

Requires **Python 3.10+** (developed on 3.11).

### 1. Create and activate a virtual environment

```bash
cd billing-software
python -m venv venv
```

| OS | Activate |
|---|---|
| Windows (PowerShell) | `venv\Scripts\Activate.ps1` |
| Windows (cmd) | `venv\Scripts\activate.bat` |
| macOS / Linux | `source venv/bin/activate` |

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

| Package | Purpose |
|---|---|
| fastapi | REST API |
| uvicorn | ASGI server |
| sqlalchemy | ORM / database |
| pydantic | input validation |
| reportlab | PDF generation (pulls in Pillow for logos) |
| python-multipart | logo upload |

---

## Running

From the project root:

```bash
uvicorn backend.main:app --reload
```

Open **http://127.0.0.1:8000** in your browser. The API docs are at
http://127.0.0.1:8000/docs.

The database (`data/billing.db`) is created automatically on first start.

**First steps:** Settings → enter business name and state → add a customer → add a
product → *New Invoice* → *Preview* → *Save & Generate PDF* → *Download PDF*.

Optional demo data (only runs on an empty database):

```bash
python -m backend.seed
```

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `BILLING_DATA_DIR` | `./data` | Database and uploaded logo |
| `BILLING_INVOICE_DIR` | `./invoices` | Generated PDFs |
| `BILLING_DATABASE_URL` | SQLite file in data dir | Any SQLAlchemy URL |
| `BILLING_PDF_FONT` / `BILLING_PDF_FONT_BOLD` | auto-detected | TTF font files containing the ₹ glyph |
| `BILLING_LOG_LEVEL` | `INFO` | Logging level |

---

## How PDF generation works

1. When an invoice is saved, `invoice_service` stores the calculated values and calls
   `pdf_generator.generate_invoice_pdf`.
2. The document is drawn with ReportLab canvas primitives (text, rules, shapes), not a
   screenshot, on a true A4 page (210 × 297 mm). **All amounts come from the backend**
   (`InvoiceOut`); the PDF code never recalculates tax or totals.
3. Layout lives in a template class. `InvoiceTemplate` holds the drawing primitives, pagination
   and page frame; `CorporateTemplate` (the default) draws the classic GST sections in a grey-scale-safe layout inside
   one frame: logos, business details and *Tax Invoice* with invoice details, Consignee / Shipped To,
   the item table, OUTPUT CGST/SGST and **Total**, amount in words, the tax summary, declaration, bank
   details, signature and the contact footer. It uses only black and greys (the logos keep their own
   colours), so it prints identically in colour and black-and-white.
4. To add a template, subclass `InvoiceTemplate`, implement its sections and register it in
   `TEMPLATES` (`generate_invoice_pdf(..., template="name")`). 
5. Long item lists flow onto further pages with the table header repeated and a "Continued…"
   note; the totals/signature block stays together on the last page. 
6. A TTF font with the **₹** glyph is auto-detected (Arial on Windows; DejaVu/Liberation on
   Linux; Arial on macOS). If none is found the PDF falls back to Helvetica and prints "Rs.".
7. The file is written atomically to `invoices/<invoice-number>.pdf`.
   `GET /api/invoices/{id}/pdf` serves it inline; `?download=true` forces a download. If the
   file is missing it is regenerated from the stored invoice.

The on-screen invoice preview (`frontend/js/views/invoice-doc.js` + `frontend/doc.css`) mirrors
this layout using the same server-calculated values.

## Design system

`frontend/style.css` starts with the design tokens (colours, spacing scale, radii, shadows,
type scale); change them there and the whole app follows. Icons are a vendored
[Lucide](https://lucide.dev) subset in `frontend/js/icons.js` (no runtime dependency). The only
external request is the optional Inter web font; the UI falls back to the system font offline.

---

## API overview

| Method | Path | |
|---|---|---|
| GET | `/api/dashboard` | dashboard numbers, outstanding, collection %, recent invoices |
| GET | `/api/dashboard/overview` | sales for `?date_from=&date_to=` (default 30 days), previous-period comparison, chart series, outstanding customers |
| GET/POST | `/api/customers` | list (`?q=`) / create |
| GET/PUT/DELETE | `/api/customers/{id}` | |
| GET/POST | `/api/products` | list (`?q=&gst_rate=&limit=&offset=`) / create |
| POST | `/api/products/import` | add/update from an `.xlsx` or CSV price list (matched on Part No) |
| GET/PUT/DELETE | `/api/products/{id}` | |
| GET/POST | `/api/invoices` | list (`?q=&status=&date_from=&date_to=&customer_id=`) / create |
| POST | `/api/invoices/preview` | calculate without saving |
| GET | `/api/invoices/next-number` | |
| GET/PUT/DELETE | `/api/invoices/{id}` | |
| PATCH | `/api/invoices/{id}/status` | Draft / Pending / Paid / Cancelled |
| POST | `/api/invoices/{id}/payments` | record a payment |
| GET | `/api/invoices/{id}/pdf` | PDF (`?download=true`) |
| POST | `/api/invoices/{id}/pdf/regenerate` | |
| GET/PUT | `/api/settings` | business settings |
| POST/GET/DELETE | `/api/settings/logo` | logo |
| GET | `/api/meta` | states, GST slabs, statuses, units |

---

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

The suite runs the full acceptance scenario (business → customer *ABC Construction* →
product *Cement* → invoice of 10 × ₹450 @ 18% → CGST/SGST ₹405 each → ₹5,310 → PDF verified as
210 × 297 mm with all required content), plus IGST, discounts, round-off, duplicate numbers,
validation, payments, overdue detection, multi-page PDFs and logo upload.

---

## Notes

* GST slabs offered: 0, 0.25, 3, 5, 12, 18, 28 and 40%. 12% and 28% are kept for goods and
  invoices that still use them.
* GSTIN format is checked softly in the UI (a warning, not a block), so test or legacy IDs can
  still be stored.
* There is no authentication yet. Run it on a trusted machine or network until Phase 3.

## Roadmap

* **Phase 2:** reports (sales, GST/HSN summary, receivables ageing), payment history with
  modes and dates, CSV/Excel export, more invoice templates, credit notes.
* **Phase 3:** authentication, user accounts, roles and permissions, multiple businesses,
  PostgreSQL, SaaS deployment.
* **Phase 4:** email and WhatsApp sharing, payment gateway / UPI QR, recurring invoices,
  GST e-invoice (IRN) and e-way bill integration, AI assistant.
