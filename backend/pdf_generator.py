"""A4 tax-invoice PDF rendering with ReportLab.

The document is built from real PDF primitives (text, tables, vector lines), not a
screenshot, on a true A4 page (210 mm x 297 mm).
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import date
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdf_canvas

from .config import PDF_FONT_BOLD_PATH, PDF_FONT_PATH
from .schemas import InvoiceOut
from .services.calculations import amount_in_words

logger = logging.getLogger("billing.pdf")

PAGE_W, PAGE_H = 210.0, 297.0  # mm
MARGIN = 8.0
BOX_W = PAGE_W - 2 * MARGIN
BOX_BOTTOM_LIMIT = 273.0  # the bordered invoice never extends below this (footer strip sits under it)

ICON_DIR = Path(__file__).resolve().parent.parent / "frontend" / "assets" / "icons"
BLUE = colors.HexColor("#1f6fb5")
INK = colors.black
GREY = colors.HexColor("#555555")


# ---------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------

_RUPEE = "\u20b9"


def _font_candidates() -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    if PDF_FONT_PATH:
        pairs.append((PDF_FONT_PATH, PDF_FONT_BOLD_PATH or PDF_FONT_PATH))
    if sys.platform == "win32":
        windows_fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
        pairs.append((str(windows_fonts / "arial.ttf"), str(windows_fonts / "arialbd.ttf")))
    pairs += [
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"),
        (
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ),
        ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        ("/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
    ]
    return pairs


@lru_cache(maxsize=1)
def _fonts() -> tuple[str, str, str]:
    """Register a TTF family with the ₹ glyph; fall back to Helvetica and 'Rs.'."""
    for regular, bold in _font_candidates():
        if not (os.path.isfile(regular) and os.path.isfile(bold)):
            continue
        try:
            regular_font = TTFont("InvoiceSans", regular)
            if ord(_RUPEE) not in regular_font.face.charToGlyph:
                continue
            pdfmetrics.registerFont(regular_font)
            pdfmetrics.registerFont(TTFont("InvoiceSans-Bold", bold))
            pdfmetrics.registerFontFamily("InvoiceSans", normal="InvoiceSans", bold="InvoiceSans-Bold")
            return "InvoiceSans", "InvoiceSans-Bold", _RUPEE
        except Exception:  # pragma: no cover - depends on system fonts
            logger.warning("Could not load font %s", regular, exc_info=True)
    logger.warning("No TTF font with the rupee sign found; using Helvetica and 'Rs.'")
    return "Helvetica", "Helvetica-Bold", "Rs."


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def format_indian(value: Decimal, places: int = 2) -> str:
    """Format a number with Indian digit grouping, e.g. 1234567.5 -> '12,34,567.50'."""
    quantized = Decimal(value).quantize(Decimal(1).scaleb(-places)) if places else Decimal(value)
    sign = "-" if quantized < 0 else ""
    text = f"{abs(quantized):.{places}f}"
    whole, _, fraction = text.partition(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    return f"{sign}{whole}" + (f".{fraction}" if fraction else "")


def format_quantity(value: Decimal) -> str:
    normalized = Decimal(value).normalize()
    text = format(normalized, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def format_rate(value: Decimal) -> str:
    return format_quantity(value)


def format_date(value: date | None) -> str:
    return value.strftime("%d-%m-%Y") if value else "-"


# ---------------------------------------------------------------------------
# Invoice document
# ---------------------------------------------------------------------------

DECLARATION = (
    "We declare that this invoice shows the actual price of the goods described "
    "and that all particulars are true and correct"
)

# (header, width mm, alignment) for the goods table; widths add up to BOX_W (194 mm).
_COLUMNS = (
    ("S No", 10, "c"),
    ("Part No", 26, "l"),
    ("Description of Goods", 42, "l"),
    ("HSN/SAC", 18, "c"),
    ("GST %", 11, "c"),
    ("Quantity", 16, "r"),
    ("Rate", 21, "r"),
    ("Per", 10, "c"),
    ("Disc.", 14, "r"),
    ("Amount", 26, "r"),
)
_LINE_H = 3.7  # mm between text lines at 8pt
_ROW_PAD = 1.4
_REF_H = 6.0  # each "Other Reference / Phone / ESN" row
_HEAD_H = 6.0  # goods table header row
_TOTAL_ROW_H = 6.0
_CONTINUED_H = 6.0

Line = tuple[str, bool, float]  # (text, bold, font size)


def _wrap(text: str, font: str, size: float, width_mm: float) -> list[str]:
    """Word-wrap `text` (honouring newlines) into lines no wider than `width_mm`."""
    max_w = width_mm * mm
    lines: list[str] = []
    for paragraph in (text or "").split("\n"):
        current = ""
        for word in paragraph.split():
            while stringWidth(word, font, size) > max_w:  # break over-long words
                cut = len(word)
                while cut > 1 and stringWidth(word[:cut], font, size) > max_w:
                    cut -= 1
                if current:
                    lines.append(current)
                    current = ""
                lines.append(word[:cut])
                word = word[cut:]
            trial = f"{current} {word}".strip()
            if current and stringWidth(trial, font, size) > max_w:
                lines.append(current)
                current = word
            else:
                current = trial
        lines.append(current)
    return lines or [""]


class InvoicePDF:
    def __init__(self, invoice: InvoiceOut, logo: Path | list[Path] | None = None, logo_heights: list[float] | None = None) -> None:
        self.invoice = invoice
        self.logos: list[Path] = [logo] if isinstance(logo, Path) else list(logo or [])
        self.logo_heights: list[float] = list(logo_heights or [])
        self.regular, self.bold, self.currency = _fonts()
        self.c: pdf_canvas.Canvas
        self.columns: list[tuple[str, float, float, str]] = []  # (header, x0, x1, align), mm
        x = MARGIN
        for header, width, align in _COLUMNS:
            self.columns.append((header, x, x + width, align))
            x += width

    # -- drawing primitives (coordinates in mm, y measured from the top) ----------------

    def _y(self, y: float) -> float:
        return (PAGE_H - y) * mm

    def line(self, x1: float, y1: float, x2: float, y2: float, width: float = 0.5) -> None:
        self.c.setLineWidth(width)
        self.c.setStrokeColor(INK)
        self.c.line(x1 * mm, self._y(y1), x2 * mm, self._y(y2))

    def text(self, x: float, y: float, value: str, size: float = 8, bold: bool = False,
             align: str = "l", color=INK) -> None:
        """Draw text with its baseline at `y`; `x` is the left, centre or right edge per `align`."""
        self.c.setFillColor(color)
        self.c.setFont(self.bold if bold else self.regular, size)
        if align == "c":
            self.c.drawCentredString(x * mm, self._y(y), value)
        elif align == "r":
            self.c.drawRightString(x * mm, self._y(y), value)
        else:
            self.c.drawString(x * mm, self._y(y), value)

    def block(self, x: float, y: float, lines: list[Line], width: float, align: str = "l") -> None:
        """Draw wrapped lines starting at top `y` inside a column `width` wide."""
        cursor = y + 3.2
        for value, bold, size in lines:
            for piece in _wrap(value, self.bold if bold else self.regular, size, width - 3.2):
                if align == "c":
                    self.text(x + width / 2, cursor, piece, size, bold, "c")
                else:
                    self.text(x + 1.6, cursor, piece, size, bold)
                cursor += _LINE_H * size / 8

    def block_height(self, lines: list[Line], width: float) -> float:
        total = 0.0
        for value, bold, size in lines:
            count = len(_wrap(value, self.bold if bold else self.regular, size, width - 3.2))
            total += count * _LINE_H * size / 8
        return total + 1.6

    def money(self, value: Decimal) -> str:
        return format_indian(value)

    # -- content --------------------------------------------------------------------------

    @staticmethod
    def _state_line(party: dict) -> str | None:
        state = party.get("state") or party.get("state_label")
        if not state:
            return None
        code = f", Code : {party['state_code']}" if party.get("state_code") else ""
        return f"State Name : {state}{code}"

    def _seller_lines(self) -> list[Line]:
        b = self.invoice.business
        lines: list[Line] = [(b.get("business_name") or "", True, 8.5)]
        if b.get("address"):
            lines.append((b["address"], True, 7.5))
        if b.get("phone"):
            phone = str(b["phone"])
            lines.append((phone if phone.startswith("+") else f"+91-{phone}", True, 7.5))
        if b.get("gstin"):
            lines.append((f"GSTIN/UIN: {b['gstin']}", True, 7.5))
        if state := self._state_line(b):
            lines.append((state, True, 7.5))
        if b.get("email"):
            lines.append((f"E-Mail : {b['email']}", True, 7.5))
        return lines

    def _party_lines(self, label: str, address: str, with_tax_ids: bool) -> list[Line]:
        c = self.invoice.customer
        lines: list[Line] = [(label, True, 7.5), (c.get("display_name") or "", True, 8)]
        if c.get("company_name") and c.get("name") and c["name"] != c["company_name"]:
            lines.append((f"Attn: {c['name']}", False, 7.5))
        if address:
            lines.append((address, False, 7.5))
        if c.get("phone"):
            lines.append((f"Phone: {c['phone']}", False, 7.5))
        if with_tax_ids:
            lines.append((f"GSTIN/UIN: {c.get('gstin') or 'Unregistered'}", True, 7.5))
            if state := self._state_line(c):
                lines.append((state, True, 7.5))
        return lines

    def _item_row(self, index: int, item) -> dict:
        desc: list[Line] = [(item.name, True, 8)]
        if item.description:
            desc.append((item.description, False, 7))
        cells = [
            "", item.part_no or "", "", item.hsn_sac or "-", f"{format_rate(item.gst_rate)}%", format_quantity(item.quantity),
            self.money(item.rate), item.unit or "",
            self.money(item.discount) if item.discount > 0 else "-", self.money(item.taxable_amount),
        ]
        desc_w = self.columns[2][2] - self.columns[2][1]
        part_w = self.columns[1][2] - self.columns[1][1] - 2.4
        part_lines = _wrap(cells[1], self.regular, 8, part_w) if cells[1] else [""]
        height = max(
            self.block_height(desc, desc_w) + _ROW_PAD,
            _LINE_H * len(part_lines) + 2 * _ROW_PAD,
            _LINE_H + 2 * _ROW_PAD,
        )
        return {"index": index, "desc": desc, "cells": cells, "height": height, "part_lines": part_lines}

    def _tax_groups(self) -> list[dict]:
        groups: dict[Decimal, dict] = {}
        for item in self.invoice.items:
            g = groups.setdefault(item.gst_rate, {
                "rate": item.gst_rate,
                "taxable": Decimal(0), "cgst": Decimal(0), "sgst": Decimal(0), "igst": Decimal(0),
            })
            g["taxable"] += item.taxable_amount
            g["cgst"] += item.cgst
            g["sgst"] += item.sgst
            g["igst"] += item.igst
        return list(groups.values())

    @staticmethod
    def _inr(words: str) -> str:
        return "INR " + words.removeprefix("Rupees ").strip() if words else ""

    def _footer_plan(self) -> dict:
        """Content and heights (mm) of every section below the goods table on the last page."""
        inv = self.invoice
        b = inv.business
        half = BOX_W / 2
        groups = self._tax_groups()
        tax_words = self._inr(amount_in_words(inv.total_tax)) if inv.total_tax > 0 else "INR Zero Only"

        bank_lines: list[Line] = [("Bank Details", True, 8)]
        for label, value in (
            ("A/c Holder", b.get("account_name") or b.get("business_name")), ("Bank", b.get("bank_name")),
            ("A/c No.", b.get("account_number")), ("IFSC", b.get("ifsc")), ("UPI", b.get("upi_id")),
        ):
            if value:
                bank_lines.append((f"{label}: {value}", False, 7.5))
        if not any(b.get(k) for k in ("bank_name", "account_number", "ifsc", "upi_id")):
            bank_lines = [("Bank Details", True, 8), ("Bank details not provided.", False, 7.5)]

        left_lines: list[Line] = [
            (f"Tax Amount (in words) :  {tax_words}", True, 7.5),
            (f"Company's PAN : {b.get('pan') or '-'}", True, 7.5),
            ("Declaration:", True, 7.5),
            (DECLARATION, False, 7.5),
        ]
        right_lines: list[Line] = []
        if inv.notes:
            right_lines += [("Notes", True, 7.5), (inv.notes, False, 7)]
        if inv.terms:
            right_lines += [("Terms & Conditions", True, 7.5), (inv.terms, False, 7)]

        plan = {
            "words": 11.0, "tax_head": 10.0, "tax_rows": 5.0 * (len(groups) + 1),
            "info": max(24.0, self.block_height(left_lines, half), self.block_height(right_lines, half)),
            "bank": max(24.0, self.block_height(bank_lines, half) + 2), "note": 5.5,
            "bank_lines": bank_lines, "left_lines": left_lines, "right_lines": right_lines, "groups": groups,
        }
        plan["total"] = sum(plan[k] for k in ("words", "tax_head", "tax_rows", "info", "bank", "note"))
        return plan

    def _tax_lines(self) -> list[tuple[str, str]]:
        inv = self.invoice
        groups = sorted(self._tax_groups(), key=lambda g: g["rate"])
        if len(groups) <= 1:  # one rate: show the invoice totals
            rate = groups[0]["rate"] if groups else Decimal(0)
            parts = [(rate, inv.igst)] if inv.is_interstate else [(rate / 2, inv.cgst), (rate / 2, inv.sgst)]
            names = ["IGST"] if inv.is_interstate else ["CGST", "SGST"]
            lines = [(f"OUTPUT {n} @ {format_rate(r)}%", self.money(v)) for n, (r, v) in zip(names, parts)]
        elif inv.is_interstate:
            lines = [(f"OUTPUT IGST @ {format_rate(g['rate'])}%", self.money(g["igst"])) for g in groups]
        else:
            lines = [(f"OUTPUT CGST @ {format_rate(g['rate'] / 2)}%", self.money(g["cgst"])) for g in groups]
            lines += [(f"OUTPUT SGST @ {format_rate(g['rate'] / 2)}%", self.money(g["sgst"])) for g in groups]
        if inv.round_off != 0:
            sign = "+" if inv.round_off > 0 else "-"
            lines.append(("Round Off", f"{sign} {self.money(abs(inv.round_off))}"))
        return lines

    @staticmethod
    def _paginate(rows: list[dict], full_h: float, last_h: float) -> list[list[dict]]:
        """Split rows into pages; the last page must also leave room for the totals/footer."""
        pages: list[list[dict]] = []
        remaining = list(rows)
        while True:
            if sum(r["height"] for r in remaining) <= last_h:
                pages.append(remaining)
                return pages
            chunk: list[dict] = []
            used = 0.0
            while remaining and (not chunk or used + remaining[0]["height"] <= full_h):
                used += remaining[0]["height"]
                chunk.append(remaining.pop(0))
            if not remaining:
                # everything fits on a plain page but not with the footer: carry the last row over
                remaining = [chunk.pop()] if len(chunk) > 1 else []
            pages.append(chunk)
            if not remaining:
                pages.append([])  # footer alone on its own page
                return pages

    # -- build ----------------------------------------------------------------------------

    def build(self, target: Path) -> Path:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        inv = self.invoice
        self.c = pdf_canvas.Canvas(str(tmp), pagesize=A4)
        self.c.setTitle(f"Tax Invoice {inv.invoice_number}")
        self.c.setAuthor(inv.business.get("business_name", ""))
        self.c.setSubject(f"Invoice for {inv.customer.get('display_name', '')}")
        self.c.setCreator("Billing Software")

        left_w = 116.0
        right_w = BOX_W - left_w
        cust = inv.customer
        billing = cust.get("billing_address", "")
        layout = {
            "header_h": max([22.0, *(h + 2.0 for h in self.logo_heights[:3])]), "left_w": left_w,
            "seller": self._seller_lines(),
            "consignee": self._party_lines("Consignee", billing, True),
            "shipped": self._party_lines("Shipped To", cust.get("shipping_address", "") or billing, False),
            "footer": self._footer_plan(), "tax_lines": self._tax_lines(),
        }
        layout["info_h"] = max(27.0 + 3 * _REF_H, self.block_height(layout["seller"], left_w))
        layout["party_h"] = max(26.0, self.block_height(layout["consignee"], left_w),
                                self.block_height(layout["shipped"], right_w))
        layout["tax_h"] = 4.6 * len(layout["tax_lines"]) + 2.0
        table_top = MARGIN + layout["header_h"] + 6.5 + layout["info_h"] + layout["party_h"]

        full_h = BOX_BOTTOM_LIMIT - table_top - _HEAD_H - _CONTINUED_H
        last_h = full_h + _CONTINUED_H - layout["footer"]["total"] - _TOTAL_ROW_H - layout["tax_h"]
        rows = [self._item_row(index, item) for index, item in enumerate(inv.items, start=1)]
        pages = self._paginate(rows, full_h, last_h)

        for number, page_rows in enumerate(pages, start=1):
            self._draw_page(page_rows, number == len(pages), number, len(pages), layout)
            self.c.showPage()
        self.c.save()
        os.replace(tmp, target)  # atomic: never leave a half-written PDF behind
        return target

    # -- one page -----------------------------------------------------------------------------

    def _draw_page(self, rows: list[dict], last: bool, number: int, count: int, g: dict) -> None:
        inv = self.invoice
        x0, x1 = MARGIN, PAGE_W - MARGIN
        y = MARGIN

        if not self._draw_logos(x0, x1, y, g["header_h"] - 2):
            self.text(x0, y + 10, inv.business.get("business_name") or "", 16, True, color=BLUE)
        if count > 1:
            self.text(x1, y + 3, f"Page {number} of {count}", 7, False, "r", GREY)
        y += g["header_h"]

        box_top = y
        self.text(PAGE_W / 2, y + 4.6, "Tax Invoice", 9, True, "c")
        y += 6.5
        self.line(x0, y, x1, y)

        # Seller (left) and invoice details (right)
        left_w, info_h = g["left_w"], g["info_h"]
        right_x = x0 + left_w
        mid = right_x + (x1 - right_x) / 2
        self.block(x0, y, g["seller"], left_w)
        top_h = info_h - 3 * _REF_H
        cell_h = top_h / 2
        meta = (
            ("Invoice No.", inv.invoice_number, "Dated", format_date(inv.invoice_date)),
            ("Place of Supply", inv.place_of_supply_label or inv.place_of_supply, None, None),
        )
        for i, (label1, value1, label2, value2) in enumerate(meta):
            cy = y + i * cell_h
            self.text(right_x + 1.6, cy + 3.3, label1, 7)
            self.text(right_x + 1.6, cy + 7.6, value1, 8, True)
            if label2:
                self.text(mid + 1.6, cy + 3.3, label2, 7)
                self.text(mid + 1.6, cy + 7.6, value2, 8, True)
                self.line(mid, cy, mid, cy + cell_h)
            if i:
                self.line(right_x, cy, x1, cy)
        self.line(right_x, y, right_x, y + info_h)
        for i, (label, value) in enumerate((
            ("Other Reference:", inv.other_reference), ("Phone :", inv.contact_phone), ("ESN:", inv.esn),
        )):
            ry = y + top_h + i * _REF_H
            self.line(right_x, ry, x1, ry)
            shown = value or "-"
            room = x1 - right_x - 3.2
            while len(shown) > 1 and stringWidth(f"{label} {shown}", self.bold, 8) / mm > room:
                shown = shown[:-2] + "…"  # keep very long values inside the box
            self.text(right_x + 1.6, ry + 4.2, f"{label} {shown}", 8, True)
        y += info_h
        self.line(x0, y, x1, y)

        # Consignee (left) and shipped-to (right)
        self.block(x0, y, g["consignee"], left_w)
        self.block(right_x, y, g["shipped"], x1 - right_x)
        self.line(right_x, y, right_x, y + g["party_h"])
        y += g["party_h"]
        self.line(x0, y, x1, y)

        # Goods table
        table_top = y
        for header, cx0, cx1, align in self.columns:
            if align == "l":
                self.text(cx0 + 1.6, y + 4.1, header, 7.5, True)
            else:
                self.text((cx0 + cx1) / 2 if align == "c" else cx1 - 1.4, y + 4.1, header, 7.5, True, align)
        y += _HEAD_H
        self.line(x0, y, x1, y)
        body_top = y
        for row in rows:
            self._draw_row(y, row)
            y += row["height"]
            self.line(x0, y, x1, y, 0.4)  # horizontal rule under every item

        if last:
            plan = g["footer"]
            body_bottom = BOX_BOTTOM_LIMIT - plan["total"] - _TOTAL_ROW_H
            body_bottom = max(body_bottom, y + g["tax_h"])
            amount_x = self.columns[-1][2] - 1.4
            ty = body_bottom - g["tax_h"] + 3.6
            for label, value in g["tax_lines"]:
                self.text(self.columns[-1][1] - 1.5, ty, label, 7.5, True, "r")
                self.text(amount_x, ty, value, 8, False, "r")
                ty += 4.6
            band_top = body_bottom - g["tax_h"]
            self._column_lines(table_top, band_top)
            self.line(x0, band_top, x1, band_top)  # rule above the tax lines
            self.line(self.columns[-1][1], band_top, self.columns[-1][1], body_bottom, 0.4)
            self.line(x0, body_bottom, x1, body_bottom)
            self.text(self.columns[2][2] - 1.5, body_bottom + 4.1, "Total", 8, True, "r")
            self.text(amount_x, body_bottom + 4.1, f"{self.currency} {self.money(inv.grand_total)}", 8.5, True, "r")
            y = body_bottom + _TOTAL_ROW_H
            self.line(x0, y, x1, y)
            y = self._draw_footer(y, g)
        else:
            body_bottom = BOX_BOTTOM_LIMIT - _CONTINUED_H
            self._column_lines(table_top, body_bottom)
            self.line(x0, body_bottom, x1, body_bottom)
            self.text(x1 - 2, body_bottom + 4.2, "Continued on next page...", 7.5, True, "r", GREY)
            y = BOX_BOTTOM_LIMIT

        self.c.setLineWidth(0.6)
        self.c.setStrokeColor(INK)
        self.c.rect(x0 * mm, self._y(y), BOX_W * mm, (y - box_top) * mm)
        self._draw_strip()

    def _column_lines(self, y_from: float, y_to: float) -> None:
        for _, cx0, _, _ in self.columns[1:]:
            self.line(cx0, y_from, cx0, y_to, 0.4)

    def _draw_row(self, y: float, row: dict) -> None:
        base = y + _ROW_PAD + 2.9
        self.text((self.columns[0][1] + self.columns[0][2]) / 2, base, str(row["index"]), 8, False, "c")
        self.block(self.columns[2][1], y + _ROW_PAD - 0.6, row["desc"], self.columns[2][2] - self.columns[2][1])
        for n, part_line in enumerate(row["part_lines"]):
            self.text(self.columns[1][1] + 1.6, base + n * _LINE_H, part_line, 8)
        for (_, cx0, cx1, align), value in list(zip(self.columns, row["cells"]))[3:]:
            if align == "c":
                self.text((cx0 + cx1) / 2, base, value, 8, False, "c")
            else:
                self.text(cx1 - 1.4, base, value, 8, False, "r")

    # -- totals, tax table, declaration, bank, signature ------------------------------------------

    def _draw_footer(self, y: float, g: dict) -> float:
        inv = self.invoice
        b = inv.business
        plan = g["footer"]
        x0, x1 = MARGIN, PAGE_W - MARGIN
        half = x0 + BOX_W / 2
        quarter = half + BOX_W / 4

        # Amount chargeable
        self.text(x0 + 1.6, y + 3.6, "Amount Chargeable (in words)", 7.5)
        self.text(x1 - 1.6, y + 3.6, "E. & O.E", 7.5, True, "r")
        self.text(x0 + 1.6, y + 8.4, self._inr(inv.amount_in_words), 8.5, True)
        y += plan["words"]
        self.line(x0, y, x1, y)

        y = self._draw_tax_table(y, plan)

        # Declaration (left) / notes and terms (right)
        self.block(x0, y, plan["left_lines"], BOX_W / 2)
        if plan["right_lines"]:
            self.block(half, y, plan["right_lines"], BOX_W / 2)
        self.line(half, y, half, y + plan["info"])
        y += plan["info"]
        self.line(x0, y, x1, y)

        # Bank details (left) / signatory (right)
        self.block(x0, y + 1.5, plan["bank_lines"], BOX_W / 2, align="c")
        self.text(quarter, y + 5, f"for {b.get('business_name') or ''}", 8, True, "c")
        self.text(quarter, y + plan["bank"] - 3, "Authorised Signatory", 8, True, "c")
        self.line(half, y, half, y + plan["bank"])
        y += plan["bank"]
        self.line(x0, y, x1, y)

        self.text(PAGE_W / 2, y + 3.9, "This is a Computer Generated Invoice", 7, True, "c")
        return y + plan["note"]

    def _draw_tax_table(self, y: float, plan: dict) -> float:
        """Tax summary: Taxable Value | Tax (Rate, Amount) | Total Tax Amount, one row per GST rate."""
        x0, x1 = MARGIN, PAGE_W - MARGIN
        widths = [94, 34, 20, 26, 20]
        xs = [x0]
        for w in widths:
            xs.append(xs[-1] + w)
        head_h = plan["tax_head"]
        top = y
        mid_y = top + head_h / 2

        def head(x_from: float, x_to: float, label: str, ty: float) -> None:
            self.text((x_from + x_to) / 2, ty, label, 7.5, True, "c")

        head(xs[1], xs[2], "Taxable", top + 4.1)
        head(xs[1], xs[2], "Value", top + 8.6)
        head(xs[2], xs[4], "Tax", top + 3.6)
        head(xs[2], xs[3], "Rate", mid_y + 3.6)
        head(xs[3], xs[4], "Amount", mid_y + 3.6)
        head(xs[4], xs[5], "Total", top + 4.1)
        head(xs[4], xs[5], "Tax Amount", top + 8.6)
        self.line(xs[2], mid_y, xs[4], mid_y, 0.4)
        self.line(x0, top, x1, top, 0.4)
        y += head_h
        self.line(x0, y, x1, y, 0.4)

        taxable_total = tax_total = Decimal(0)
        for gr in plan["groups"]:
            ty = y + 3.7
            tax = gr["igst"] if self.invoice.is_interstate else gr["cgst"] + gr["sgst"]
            self.text(xs[2] - 1.4, ty, self.money(gr["taxable"]), 8, False, "r")
            self.text(xs[3] - 1.4, ty, f"{format_rate(gr['rate'])}%", 8, False, "r")
            self.text(xs[4] - 1.4, ty, self.money(tax), 8, False, "r")
            self.text(xs[5] - 1.4, ty, self.money(tax), 8, False, "r")
            taxable_total += gr["taxable"]
            tax_total += tax
            y += 5.0

        self.line(x0, y, x1, y, 0.4)
        ty = y + 3.7
        self.text(xs[1] - 1.4, ty, "Total", 8, True, "r")
        self.text(xs[2] - 1.4, ty, self.money(taxable_total), 8, True, "r")
        self.text(xs[4] - 1.4, ty, self.money(tax_total), 8, True, "r")
        self.text(xs[5] - 1.4, ty, self.money(tax_total), 8, True, "r")
        y += 5.0

        # vertical dividers; Rate/Amount only start below the "Tax" heading
        for xv in xs[1:-1]:
            self.line(xv, mid_y if xv == xs[3] else top, xv, y, 0.4)
        self.line(x0, y, x1, y)
        return y

    # -- logo and contact strip -------------------------------------------------------------------

    def _draw_logos(self, x0: float, x1: float, y: float, max_h: float) -> bool:
        """Draw up to three logos across the header: first at the left, last at the right."""
        images = []
        for position, path in enumerate(self.logos[:3]):
            try:
                reader = ImageReader(str(path))
                images.append((reader, *reader.getSize(), self.logo_heights[position] if position < len(self.logo_heights) else 20.0))
            except Exception:
                logger.warning("Unreadable logo at %s", path, exc_info=True)
        if not images:
            return False
        max_w = (x1 - x0) / len(images) - 4.0  # logos share the header width
        for position, (reader, width, height, wanted_h) in enumerate(images):
            scale = min(max_w / width, min(wanted_h, max_h) / height)
            w, h = width * scale, height * scale
            if position == 0:
                x = x0
            elif position == len(images) - 1:
                x = x1 - w
            else:
                x = (x0 + x1) / 2 - w / 2
            self.c.drawImage(reader, x * mm, self._y(y + 1 + h), w * mm, h * mm, mask="auto")
        return True

    def _icon(self, kind: str, cx: float, cy: float) -> None:
        """Draw the call / WhatsApp / mail logo (4 mm square) centred at (cx, cy) mm."""
        path = ICON_DIR / f"{kind}.png"
        if path.exists():
            self.c.drawImage(ImageReader(str(path)), (cx - 2) * mm, self._y(cy + 2), 4 * mm, 4 * mm, mask="auto")


    def _draw_strip(self) -> None:
        """Blue contact strip at the foot of every page, with call / WhatsApp / mail icons, inside a page outline."""
        b = self.invoice.business
        phone, whatsapp, email = (b.get(k) or "" for k in ("footer_phone", "footer_whatsapp", "footer_email"))
        items: list[tuple[list[str], str]] = []  # (icons, text)
        if phone and whatsapp and phone.strip() == whatsapp.strip():
            items.append((["call", "whatsapp"], phone))
        else:
            if phone:
                items.append((["call"], phone))
            if whatsapp:
                items.append((["whatsapp"], whatsapp))
        if email:
            items.append((["mail"], email))
        if items:
            icon_w, gap_icon, gap_item, size = 4.0, 1.6, 8.0, 10
            widths = [
                len(icons) * icon_w + (len(icons) - 1) * 0.8 + gap_icon + stringWidth(value, self.bold, size) / mm
                for icons, value in items
            ]
            x = PAGE_W / 2 - (sum(widths) + gap_item * (len(items) - 1)) / 2
            base = 281.0
            for (icons, value), width in zip(items, widths):
                for n, icon in enumerate(icons):
                    self._icon(icon, x + icon_w / 2 + n * (icon_w + 0.8), base - 1.3)
                self.text(x + width - stringWidth(value, self.bold, size) / mm, base, value, size, True, "l", BLUE)
                x += width + gap_item
        if b.get("footer_address"):
            self.text(PAGE_W / 2, 286.0, " ".join(b["footer_address"].split()), 7.5, True, "c", BLUE)
        self.c.setFillColor(colors.HexColor("#8cc4ee"))
        self.c.rect(0, 6.0 * mm, PAGE_W * mm, 1.2 * mm, stroke=0, fill=1)
        self.c.setFillColor(BLUE)
        self.c.rect(0, 0, PAGE_W * mm, 6.0 * mm, stroke=0, fill=1)
        # outline around the whole invoice page
        self.c.setStrokeColor(INK)
        self.c.setLineWidth(0.6)
        self.c.rect(4 * mm, self._y(PAGE_H - 8.7), (PAGE_W - 8) * mm, (PAGE_H - 8.7 - 4) * mm)


def generate_invoice_pdf(invoice: InvoiceOut, target: Path, logo: Path | list[Path] | None = None, logo_heights: list[float] | None = None) -> Path:
    return InvoicePDF(invoice, logo, logo_heights).build(target)
