"""A4 tax-invoice PDF rendering with ReportLab.

The document is built from real PDF primitives (text, rules, shapes), not a screenshot, on a true
A4 page (210 mm x 297 mm). Layout lives in template classes (see InvoiceTemplate / CorporateTemplate);
all amounts come from the backend InvoiceOut, nothing is recalculated here.
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

ICON_DIR = Path(__file__).resolve().parent.parent / "frontend" / "assets" / "icons"


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

# Greys only: the invoice must look the same in colour and in black-and-white.
DARK = colors.HexColor("#1a1a1a")      # major borders, titles
TEXT = colors.HexColor("#111111")
SOFT = colors.HexColor("#4a4a4a")      # secondary text
MID = colors.HexColor("#9a9a9a")       # section rules
LIGHT = colors.HexColor("#cfcfcf")     # table lines
FILL_HEAD = colors.HexColor("#e4e4e4")  # table / tax-summary headers
FILL_BAND = colors.HexColor("#f0f0f0")  # section labels, total row
WHITE = colors.white

LEAD = 3.7           # line height at 8 pt (mm)
# Bump LAYOUT_VERSION whenever the PDF layout changes: stored PDFs from an older layout are then re-rendered.
LAYOUT_VERSION = 3
PDF_CREATOR = f"OHM Powerin Billing (layout {LAYOUT_VERSION})"
CONTINUED_H = 6.0    # "Continued on next page" row

Line = tuple[str, bool, float]  # (text, bold, font size)


def _wrap(text: str, font: str, size: float, width_mm: float) -> list[str]:
    """Word-wrap `text` (honouring newlines) into lines no wider than `width_mm`."""
    max_w = width_mm * mm
    lines: list[str] = []
    for paragraph in str(text).split("\n"):
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
            candidate = f"{current} {word}".strip()
            if stringWidth(candidate, font, size) <= max_w:
                current = candidate
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines or [""]


class InvoiceTemplate:
    """Base class: drawing primitives, pagination and the page loop shared by every template.

    A template sets the page geometry (`left`, `right`, `top`, `bottom`, `head_h`) and implements the
    sections: `header_first`, `header_continued`, `parties`, `draw_table_head`, `make_row` / `row_height` /
    `draw_row`, `draw_columns`, `footer` and the per-page `draw_frame` / `draw_page_footer`.
    Section methods return the height they used and respect `self.dry` (measure only), so the same code
    both plans and draws a page. To add a template, subclass this and register it in TEMPLATES.
    """

    name = "base"
    left, right = 10.0, 200.0
    top, bottom = 10.0, 274.0   # content area; the template may draw a frame / page footer outside it
    head_h = 8.0                # goods-table header row
    anchor_footer = True        # last-page footer sits at the bottom, the item area stretches to fill

    def __init__(self, invoice: InvoiceOut, logo: Path | list[Path] | None = None, logo_heights: list[float] | None = None) -> None:
        self.invoice = invoice
        self.logos: list[Path] = [logo] if isinstance(logo, Path) else list(logo or [])
        self.logo_heights: list[float] = list(logo_heights or [])
        self.regular, self.bold, self.currency = _fonts()
        self.c: pdf_canvas.Canvas
        self.dry = False
        self.footer_h = 0.0
        self.k = 1.0  # spacing scale; build() shrinks it (compact mode) to keep an invoice on a single page

    @property
    def width_mm(self) -> float:
        return self.right - self.left

    # -- drawing primitives (mm; y measured from the top) -------------------------------------

    def _y(self, y: float) -> float:
        return (PAGE_H - y) * mm

    def line(self, x1: float, y1: float, x2: float, y2: float, width: float = 0.5, color=DARK) -> None:
        if self.dry:
            return
        self.c.setLineWidth(width)
        self.c.setStrokeColor(color)
        self.c.line(x1 * mm, self._y(y1), x2 * mm, self._y(y2))

    def rect(self, x: float, y: float, w: float, h: float, fill=None, stroke=None, width: float = 0.5) -> None:
        if self.dry:
            return
        self.c.setLineWidth(width)
        if fill is not None:
            self.c.setFillColor(fill)
        if stroke is not None:
            self.c.setStrokeColor(stroke)
        self.c.rect(x * mm, self._y(y + h), w * mm, h * mm, stroke=int(stroke is not None), fill=int(fill is not None))

    def text(self, x: float, y: float, value: str, size: float = 8, bold: bool = False,
             align: str = "l", color=TEXT) -> None:
        """Draw text whose *top* is at `y`; `x` is the left, centre or right edge according to `align`."""
        if self.dry:
            return
        baseline = y + size * 0.3528 * 0.82
        self.c.setFillColor(color)
        self.c.setFont(self.bold if bold else self.regular, size)
        if align == "c":
            self.c.drawCentredString(x * mm, self._y(baseline), value)
        elif align == "r":
            self.c.drawRightString(x * mm, self._y(baseline), value)
        else:
            self.c.drawString(x * mm, self._y(baseline), value)

    def tw(self, value: str, size: float, bold: bool = False) -> float:
        return stringWidth(value, self.bold if bold else self.regular, size) / mm

    def para(self, x: float, y: float, value: str, w: float, size: float = 8, bold: bool = False,
             color=TEXT, align: str = "l", leading: float | None = None) -> float:
        """Draw wrapped text inside a column `w` wide; returns the height used."""
        leading = leading or size * 0.3528 * 1.42
        pieces = _wrap(value, self.bold if bold else self.regular, size, w)
        for n, piece in enumerate(pieces):
            tx = {"l": x, "c": x + w / 2, "r": x + w}[align]
            self.text(tx, y + n * leading, piece, size, bold, align, color)
        return len(pieces) * leading

    def para_h(self, value: str, w: float, size: float = 8, bold: bool = False, leading: float | None = None) -> float:
        leading = leading or size * 0.3528 * 1.42
        return len(_wrap(value, self.bold if bold else self.regular, size, w)) * leading

    def sc(self, value: float, floor: float) -> float:
        """A spacing value scaled by the compact factor, but never below `floor` (so text never collides)."""
        return max(floor, value * self.k)

    def money(self, value: Decimal) -> str:
        return format_indian(value)

    # -- template contract -----------------------------------------------------------------------

    def header_first(self) -> float:
        raise NotImplementedError

    def header_continued(self, number: int, count: int) -> float:
        raise NotImplementedError

    def parties(self, y: float) -> float:
        raise NotImplementedError

    def make_row(self, index: int, item) -> dict:
        raise NotImplementedError

    def row_height(self, row: dict) -> float:
        raise NotImplementedError

    def draw_row(self, y: float, row: dict) -> None:
        raise NotImplementedError

    def draw_table_head(self, y: float) -> None:
        raise NotImplementedError

    def draw_columns(self, y0: float, y1: float) -> None:
        """Vertical column rules between y0 and y1 (the item area, including any stretched filler)."""

    def footer(self, y: float) -> float:
        raise NotImplementedError

    def draw_frame(self, number: int, count: int) -> None:
        """Page border, drawn last on every page."""

    def draw_page_footer(self) -> None:
        """Per-page footer (contact strip)."""

    # -- pagination ----------------------------------------------------------------------------------

    @staticmethod
    def _paginate(rows: list[dict], first_cap: float, next_cap: float, continued_h: float, last_reserve: float) -> list[list[dict]]:
        """Split rows into pages. Every page but the last keeps room for 'Continued…'; the last keeps room for the footer."""
        pages: list[list[dict]] = []
        remaining = list(rows)
        while True:
            cap = first_cap if not pages else next_cap
            if sum(r["height"] for r in remaining) <= cap + continued_h - last_reserve:
                pages.append(remaining)
                return pages
            chunk: list[dict] = []
            used = 0.0
            while remaining and (not chunk or used + remaining[0]["height"] <= cap):
                used += remaining[0]["height"]
                chunk.append(remaining.pop(0))
            if not remaining:
                # everything fits on a plain page but not together with the footer: carry the last row over
                remaining = [chunk.pop()] if len(chunk) > 1 else []
            pages.append(chunk)
            if not remaining:
                pages.append([])  # footer alone on its own page
                return pages

    # -- build -------------------------------------------------------------------------------------------

    def build(self, target: Path) -> Path:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        inv = self.invoice
        self.c = pdf_canvas.Canvas(str(tmp), pagesize=A4)
        self.c.setTitle(f"Tax Invoice {inv.invoice_number}")
        self.c.setAuthor(inv.business.get("business_name", ""))
        self.c.setSubject(f"Invoice for {inv.customer.get('display_name', '')}")
        self.c.setCreator(PDF_CREATOR)

        rows = [self.make_row(i, item) for i, item in enumerate(inv.items, start=1)]
        pages: list[list[dict]] = []
        # One page whenever possible: if the normal spacing needs more, retry with tighter spacing and keep the shorter result.
        for k in (1.0, 0.9, 0.8, 0.7, 0.6, 0.5):
            self.k = k
            self.__dict__.pop("_cols", None)
            candidate = self._plan(rows)
            if not pages or len(candidate) < len(pages):
                pages, best = candidate, k
            if len(pages) == 1:
                break
        self.k = best
        pages = self._plan(rows)

        for number, page_rows in enumerate(pages, start=1):
            self._draw_page(page_rows, number, len(pages))
            self.c.showPage()
        self.c.save()
        os.replace(tmp, target)  # atomic: never leave a half-written PDF behind
        return target

    def _plan(self, rows: list[dict]) -> list[list[dict]]:
        """Measure the fixed blocks (dry run) and split the item rows into pages at the current spacing."""
        self.dry = True
        first_top = self.top + self.header_first()
        first_top += self.parties(first_top)
        cont_top = self.top + self.header_continued(1, 2)
        self.footer_h = self.footer(0.0)
        self.dry = False
        for row in rows:
            row["height"] = self.row_height(row)
        first_cap = self.bottom - first_top - self.head_h - CONTINUED_H
        next_cap = self.bottom - cont_top - self.head_h - CONTINUED_H
        return self._paginate(rows, first_cap, next_cap, CONTINUED_H, self.footer_h)

    def _draw_page(self, rows: list[dict], number: int, count: int) -> None:
        y = self.top
        if number == 1:
            y += self.header_first()
            y += self.parties(y)
        else:
            y += self.header_continued(number, count)
        self.draw_table_head(y)
        y += self.head_h
        body_top = y
        for row in rows:
            self.draw_row(y, row)
            y += row["height"]
            self.line(self.left, y, self.right, y, 0.25, LIGHT)
        if number == count:
            fy = max(y, self.bottom - self.footer_h) if self.anchor_footer else y
            self.draw_columns(body_top, fy)
            self.footer(fy)
        else:
            end = self.bottom - CONTINUED_H
            self.draw_columns(body_top, end)
            self.line(self.left, end, self.right, end, 0.5, DARK)
            self.text(self.right - 2.5, end + 1.8, f"Continued on next page  ·  Page {number} of {count}", 7.5, True, "r", SOFT)
        self.draw_page_footer()
        self.draw_frame(number, count)

    # -- logos ------------------------------------------------------------------------------------------------

    def draw_logo_row(self, y: float, max_h: float = 40.0, pad: float = 3.0) -> float:
        """Logos across the header: first at the left, last at the right (middle one centred). Returns the height used."""
        images = []
        for position, path in enumerate(self.logos[:3]):
            try:
                reader = ImageReader(str(path))
                width, height = reader.getSize()
                wanted = self.logo_heights[position] if position < len(self.logo_heights) else 20.0
                images.append((reader, width, height, min(float(wanted), max_h)))
            except Exception:
                logger.warning("Unreadable logo at %s", path, exc_info=True)
        if not images:
            return 0.0
        x0, x1 = self.left + pad, self.right - pad
        max_w = (x1 - x0) / len(images) - 4.0
        tallest = 0.0
        for position, (reader, width, height, wanted_h) in enumerate(images):
            scale = min(max_w / width, wanted_h / height)
            w, h = width * scale, height * scale
            tallest = max(tallest, h)
            if position == 0:
                x = x0
            elif position == len(images) - 1:
                x = x1 - w
            else:
                x = (x0 + x1) / 2 - w / 2
            if not self.dry:
                self.c.drawImage(reader, x * mm, self._y(y + h), w * mm, h * mm, mask="auto")
        return tallest

    def _icon(self, kind: str, cx: float, cy: float, size: float = 3.6) -> None:
        """Contact icon (grey variant, so it prints well in black-and-white) centred at (cx, cy) mm."""
        path = ICON_DIR / f"{kind}-gray.png"
        if path.exists() and not self.dry:
            self.c.drawImage(ImageReader(str(path)), (cx - size / 2) * mm, self._y(cy + size / 2), size * mm, size * mm, mask="auto")


class CorporateTemplate(InvoiceTemplate):
    """Default OHM Powerin invoice: classic GST sections in a clean, grey-scale-safe corporate layout."""

    name = "corporate"
    LABEL_W = 29.0  # width of the label column in the invoice-details block

    # -- small helpers ----------------------------------------------------------------------------

    @staticmethod
    def _state_line(party: dict) -> str | None:
        state = party.get("state") or party.get("state_label")
        if not state:
            return None
        code = f", Code : {party['state_code']}" if party.get("state_code") else ""
        return f"State Name : {state}{code}"

    @staticmethod
    def _inr(words: str) -> str:
        return "INR " + words.removeprefix("Rupees ").strip() if words else ""

    def _tax_groups(self) -> list[dict]:
        groups: dict[Decimal, dict] = {}
        for item in self.invoice.items:
            g = groups.setdefault(item.gst_rate, {
                "rate": item.gst_rate, "taxable": Decimal(0), "cgst": Decimal(0), "sgst": Decimal(0), "igst": Decimal(0),
            })
            g["taxable"] += item.taxable_amount
            g["cgst"] += item.cgst
            g["sgst"] += item.sgst
            g["igst"] += item.igst
        return sorted(groups.values(), key=lambda g: g["rate"])

    def _tax_lines(self) -> list[tuple[str, str]]:
        inv = self.invoice
        groups = self._tax_groups()
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

    # -- item-table geometry --------------------------------------------------------------------------

    _SPEC = (
        ("S No", 10, "c"), ("Part No", 24, "l"), ("Description of Goods", None, "l"), ("HSN/SAC", 18, "c"),
        ("GST %", 12, "c"), ("Quantity", 16, "r"), ("Rate", 21, "r"), ("Per", 11, "c"), ("Disc.", 14, "r"), ("Amount", 24, "r"),
    )

    def columns(self) -> list[tuple[str, float, float, str]]:
        if not hasattr(self, "_cols"):
            fixed = sum(w for _, w, _ in self._SPEC if w)
            cols, x = [], self.left
            for header, w, align in self._SPEC:
                w = w or self.width_mm - fixed
                cols.append((header, x, x + w, align))
                x += w
            self._cols = cols
        return self._cols

    def _col(self, header: str) -> tuple[float, float]:
        for h, x0, x1, _ in self.columns():
            if h == header:
                return x0, x1
        raise KeyError(header)

    # -- header -----------------------------------------------------------------------------------------------

    @property
    def split_x(self) -> float:
        return self.left + 112.0  # divider between the seller / consignee column and the details column

    def header_first(self) -> float:
        inv, b = self.invoice, self.invoice.business
        y = self.top
        logo_h = self.draw_logo_row(y + 3.0)
        if logo_h:
            y += logo_h + 6.0
            self.line(self.left, y, self.right, y, 0.5, MID)
        pad = 3.0
        col_w = self.split_x - self.left - 2 * pad

        # seller (left)
        sy = y + 2.8
        sy += self.para(self.left + pad, sy, b.get("business_name") or "", col_w, 12, True, TEXT) + 0.9
        if b.get("address"):
            sy += self.para(self.left + pad, sy, b["address"], col_w, 8, False, SOFT)
        if b.get("phone"):
            phone = str(b["phone"])
            sy += self.para(self.left + pad, sy, phone if phone.startswith("+") else f"+91-{phone}", col_w, 8, False, SOFT)
        if b.get("gstin"):
            sy += self.para(self.left + pad, sy, f"GSTIN/UIN: {b['gstin']}", col_w, 8, True, TEXT)
        if state := self._state_line(b):
            sy += self.para(self.left + pad, sy, state, col_w, 8, False, SOFT)
        if b.get("email"):
            sy += self.para(self.left + pad, sy, f"E-Mail : {b['email']}", col_w, 8, False, SOFT)
        left_h = sy + 2.5 - y

        # tax invoice + invoice details (right)
        rx = self.split_x + pad
        ry = y + 2.8
        details = (
            ("Invoice No.", inv.invoice_number, True), ("Dated", format_date(inv.invoice_date), False),
            ("Other Reference", inv.other_reference or "-", False), ("Phone", inv.contact_phone or "-", False),
            ("ESN", inv.esn or "-", False),
        )
        for n, (label, value, strong) in enumerate(details):
            if n:
                self.line(self.split_x, ry - 0.5, self.right, ry - 0.5, 0.25, LIGHT)
            self.text(rx, ry + 0.4, label, 7.8, True, "l", SOFT)
            self.para(rx + self.LABEL_W, ry + 0.2, str(value), self.right - rx - self.LABEL_W - pad, 9 if strong else 8.4, strong, TEXT)
            ry += 5.4
        right_h = ry + 1.0 - y
        height = max(left_h, right_h)
        self.line(self.split_x, y, self.split_x, y + height, 0.4, MID)
        self.line(self.left, y + height, self.right, y + height, 0.5, DARK)
        return (y - self.top) + height

    def header_continued(self, number: int, count: int) -> float:
        inv, b = self.invoice, self.invoice.business
        y = self.top
        self.text(self.left + 3.0, y + 3.0, b.get("business_name") or "", 11, True, "l", TEXT)
        self.text(self.right - 3.0, y + 3.2, f"Invoice No. {inv.invoice_number}   ·   Dated {format_date(inv.invoice_date)}   ·   Page {number} of {count}", 8, False, "r", SOFT)
        self.line(self.left, y + 14.0, self.right, y + 14.0, 0.5, DARK)
        return 14.0

    # -- consignee / shipped to ---------------------------------------------------------------------------------

    def parties(self, y: float) -> float:
        cust = self.invoice.customer
        billing = cust.get("billing_address", "")
        shipping = cust.get("shipping_address", "") or billing
        pad = 3.0
        widths = (self.split_x - self.left, self.right - self.split_x)

        def content(kind: str) -> list[tuple[str, bool, float, object]]:
            lines: list[tuple[str, bool, float, object]] = [(cust.get("display_name") or "", True, 9, TEXT)]
            if kind == "consignee":
                if cust.get("company_name") and cust.get("name"):
                    lines.append((f"Attn: {cust['name']}", False, 8, SOFT))
                if billing:
                    lines.append((billing, False, 8, SOFT))
                if cust.get("phone"):
                    lines.append((f"Phone: {cust['phone']}", False, 8, SOFT))
                lines.append((f"GSTIN/UIN: {cust.get('gstin') or 'Unregistered'}", True, 8, TEXT))
                if state := self._state_line(cust):
                    lines.append((state, False, 8, SOFT))
            else:
                if cust.get("company_name") and cust.get("name"):
                    lines.append((f"Attn: {cust['name']}", False, 8, SOFT))
                if shipping:
                    lines.append((shipping, False, 8, SOFT))
            return lines

        band_h = 5.4
        blocks = []
        for kind, label, w in (("consignee", "CONSIGNEE", widths[0]), ("shipped", "SHIPPED TO", widths[1])):
            lines = content(kind)
            h = sum(self.para_h(v, w - 2 * pad, size, bold) + 0.5 for v, bold, size, _ in lines)
            blocks.append((label, lines, h))
        body_h = max(h for _, _, h in blocks) + 5.0
        height = band_h + max(body_h, self.sc(22.0, 16.0))

        x = self.left
        for (label, lines, _), w in zip(blocks, widths):
            self.rect(x, y, w, band_h, fill=FILL_BAND)
            self.text(x + pad, y + 1.45, label, 7.5, True, "l", TEXT)
            cy = y + band_h + 2.4
            for value, bold, size, color in lines:
                cy += self.para(x + pad, cy, value, w - 2 * pad, size, bold, color) + 0.5
            x += w
        self.line(self.left, y + band_h, self.right, y + band_h, 0.3, MID)
        self.line(self.split_x, y, self.split_x, y + height, 0.4, MID)
        self.line(self.left, y + height, self.right, y + height, 0.5, DARK)
        return height

    # -- item table ------------------------------------------------------------------------------------------------

    def draw_table_head(self, y: float) -> None:
        self.rect(self.left, y, self.width_mm, self.head_h, fill=FILL_HEAD)
        self.line(self.left, y + self.head_h, self.right, y + self.head_h, 0.6, DARK)
        ty = y + (self.head_h - 7.6 * 0.3528) / 2 - 0.15
        for header, x0, x1, align in self.columns():
            if align == "l":
                self.text(x0 + 2.2, ty, header, 7.6, True, "l")
            elif align == "r":
                self.text(x1 - 2.2, ty, header, 7.6, True, "r")
            else:
                self.text((x0 + x1) / 2, ty, header, 7.6, True, "c")
        for _, x0, _, _ in self.columns()[1:]:
            self.line(x0, y, x0, y + self.head_h, 0.3, MID)

    def make_row(self, index: int, item) -> dict:
        p0, p1 = self._col("Part No")
        d0, d1 = self._col("Description of Goods")
        return {
            "index": index, "item": item,
            "part": _wrap(item.part_no, self.regular, 8, p1 - p0 - 4.4) if item.part_no else [""],
            "name": _wrap(item.name, self.bold, 8, d1 - d0 - 4.4),
            "desc": _wrap(item.description, self.regular, 7, d1 - d0 - 4.4) if item.description else [],
        }

    def row_height(self, row: dict) -> float:
        text_h = max(len(row["part"]) * LEAD, len(row["name"]) * LEAD + len(row["desc"]) * 3.3, LEAD)
        return max(text_h + self.sc(4.4, 3.2), self.sc(8.0, 5.5))

    def draw_row(self, y: float, row: dict) -> None:
        item, ty = row["item"], y + 2.4
        cells = {
            "S No": str(row["index"]), "HSN/SAC": item.hsn_sac or "-", "GST %": f"{format_rate(item.gst_rate)}%",
            "Quantity": format_quantity(item.quantity), "Rate": self.money(item.rate), "Per": item.unit or "",
            "Disc.": self.money(item.discount) if item.discount > 0 else "-", "Amount": self.money(item.taxable_amount),
        }
        for header, x0, x1, align in self.columns():
            if header == "Part No":
                for n, piece in enumerate(row["part"]):
                    self.text(x0 + 2.2, ty + n * LEAD, piece, 8)
            elif header == "Description of Goods":
                cy = ty
                for piece in row["name"]:
                    self.text(x0 + 2.2, cy, piece, 8, True)
                    cy += LEAD
                for piece in row["desc"]:
                    self.text(x0 + 2.2, cy, piece, 7, False, "l", SOFT)
                    cy += 3.3
            elif align == "r":
                self.text(x1 - 2.2, ty, cells[header], 8, header == "Amount", "r")
            else:
                self.text((x0 + x1) / 2, ty, cells[header], 8, False, "c")

    def draw_columns(self, y0: float, y1: float) -> None:
        for _, x0, _, _ in self.columns()[1:]:
            self.line(x0, y0, x0, y1, 0.25, LIGHT)

    # -- footer: tax lines, total, words, tax summary, declaration, bank, signature -----------------------------------

    def footer(self, y: float) -> float:
        inv, b = self.invoice, self.invoice.business
        start, L, R = y, self.left, self.right
        W = self.width_mm
        am0, am1 = self._col("Amount")

        # --- OUTPUT CGST / SGST / Round Off, then the total ---
        self.line(L, y, R, y, 0.5, DARK)
        lines = self._tax_lines()
        ty = y + 2.0
        for label, value in lines:
            self.text(am0 - 3.0, ty, label, 8, True, "r", SOFT if label == "Round Off" else TEXT)
            self.text(am1 - 2.2, ty, value, 8.4, False, "r")
            ty += self.sc(5.0, 4.1)
        ty += 1.2
        self.line(am0, y, am0, ty, 0.25, LIGHT)
        self.line(L, ty, R, ty, 1.0, DARK)               # heavier rule above the total
        box = self.sc(9.0, 8.0)
        self.rect(L, ty, W, box, fill=FILL_BAND)
        total_text = f"{self.currency} {self.money(inv.grand_total)}"
        # The label sits just left of the amount however wide the amount is.
        self.text(R - 2.5 - self.tw(total_text, 12.5, True) - 4.0, ty + 2.5 * box / 9.0, "Total", 10.5, True, "r")
        self.text(R - 2.5, ty + 2.2 * box / 9.0, total_text, 12.5, True, "r")
        self.line(L, ty + box, R, ty + box, 0.5, DARK)
        y = ty + box

        # --- amount chargeable (in words) ---
        self.text(L + 3.0, y + 2.0, "Amount Chargeable (in words)", 7.8, True, "l", SOFT)
        self.text(R - 3.0, y + 2.0, "E. & O.E", 7.8, True, "r", SOFT)
        wy = y + self.sc(6.6, 5.8)
        wy += self.para(L + 3.0, wy, self._inr(inv.amount_in_words), W - 6.0, 9, True)
        y = wy + self.sc(2.2, 1.6)
        self.line(L, y, R, y, 0.5, DARK)

        # --- tax summary ---
        groups = self._tax_groups()
        widths = [90.0, 34.0, 20.0, 26.0, 20.0]
        xs = [L]
        for w in widths:
            xs.append(xs[-1] + w)
        head_h = 10.0
        self.rect(L, y, W, head_h, fill=FILL_HEAD)
        centre = lambda a, z, label, ty_: self.text((a + z) / 2, ty_, label, 7.6, True, "c")  # noqa: E731
        centre(xs[1], xs[2], "Taxable", y + 1.6)
        centre(xs[1], xs[2], "Value", y + 5.6)
        centre(xs[2], xs[4], "Tax", y + 1.2)
        centre(xs[2], xs[3], "Rate", y + 6.2)
        centre(xs[3], xs[4], "Amount", y + 6.2)
        centre(xs[4], xs[5], "Total", y + 1.6)
        centre(xs[4], xs[5], "Tax Amount", y + 5.6)
        self.line(xs[2], y + head_h / 2, xs[4], y + head_h / 2, 0.3, MID)
        gy = y + head_h
        self.line(L, gy, R, gy, 0.6, DARK)
        taxable_total = tax_total = Decimal(0)
        for g in groups:
            tax = g["igst"] if inv.is_interstate else g["cgst"] + g["sgst"]
            self.text(xs[2] - 2.2, gy + 1.5, self.money(g["taxable"]), 8, False, "r")
            self.text(xs[3] - 2.2, gy + 1.5, f"{format_rate(g['rate'])}%", 8, False, "r")
            self.text(xs[4] - 2.2, gy + 1.5, self.money(tax), 8, False, "r")
            self.text(xs[5] - 2.2, gy + 1.5, self.money(tax), 8, False, "r")
            taxable_total += g["taxable"]
            tax_total += tax
            gy += self.sc(5.4, 4.6)
            self.line(L, gy, R, gy, 0.25, LIGHT)
        self.line(L, gy, R, gy, 0.5, MID)
        self.text(xs[1] - 2.2, gy + 1.5, "Total", 8, True, "r")
        self.text(xs[2] - 2.2, gy + 1.5, self.money(taxable_total), 8, True, "r")
        self.text(xs[4] - 2.2, gy + 1.5, self.money(tax_total), 8, True, "r")
        self.text(xs[5] - 2.2, gy + 1.5, self.money(tax_total), 8, True, "r")
        gy += self.sc(5.4, 4.6)
        for xv in xs[1:-1]:
            self.line(xv, y + head_h / 2 if xv == xs[3] else y, xv, gy, 0.25, LIGHT)
        self.line(L, gy, R, gy, 0.5, DARK)
        y = gy

        # --- tax amount in words / PAN / declaration  |  notes & terms ---
        half = W / 2
        pad = 3.0
        tax_words = self._inr(amount_in_words(inv.total_tax)) if inv.total_tax > 0 else "INR Zero Only"
        ly = y + 2.6
        ly += self.para(L + pad, ly, f"Tax Amount (in words) :  {tax_words}", half - 2 * pad, 8, True) + 1.4
        ly += self.para(L + pad, ly, f"Company's PAN : {b.get('pan') or '-'}", half - 2 * pad, 8, True) + 1.4
        ly += self.para(L + pad, ly, "Declaration:", half - 2 * pad, 8, True) + 0.4
        ly += self.para(L + pad, ly, DECLARATION, half - 2 * pad, 7.8, False, SOFT)
        ry = y + 2.6
        if inv.notes:
            ry += self.para(L + half + pad, ry, "Notes", half - 2 * pad, 8, True) + 0.4
            ry += self.para(L + half + pad, ry, inv.notes, half - 2 * pad, 7.6, False, SOFT) + 1.6
        if inv.terms:
            ry += self.para(L + half + pad, ry, "Terms & Conditions", half - 2 * pad, 8, True) + 0.4
            ry += self.para(L + half + pad, ry, inv.terms, half - 2 * pad, 7.6, False, SOFT)
        info_h = max(ly, ry, y + self.sc(22.0, 16.0)) + 2.4 - y
        self.line(L + half, y, L + half, y + info_h, 0.4, MID)
        y += info_h
        self.line(L, y, R, y, 0.5, MID)

        # --- bank details  |  for <business> / authorised signatory ---
        bank = [(label, value) for label, value in (
            ("A/c Holder", b.get("account_name") or b.get("business_name")), ("Bank", b.get("bank_name")), ("Branch", b.get("bank_branch")),
            ("A/c No.", b.get("account_number")), ("IFSC", b.get("ifsc")), ("UPI", b.get("upi_id")),
        ) if value]
        if not any(b.get(k) for k in ("bank_name", "account_number", "ifsc", "upi_id")):
            bank = []
        by = y + 2.6
        by += self.para(L + pad, by, "Bank Details", half - 2 * pad, 8.6, True) + 1.0
        if bank:
            for label, value in bank:
                self.text(L + pad, by, f"{label}", 7.8, False, "l", SOFT)
                by += self.para(L + pad + 22.0, by, str(value), half - 2 * pad - 22.0, 8, True) + 0.7
        else:
            by += self.para(L + pad, by, "Bank details not provided.", half - 2 * pad, 8, False, SOFT)
        bank_h = max(by, y + self.sc(30.0, 24.0)) + 2.0 - y
        cx = L + half + half / 2
        self.text(cx, y + 3.0, f"for {b.get('business_name') or ''}", 9, True, "c")
        sign_y = y + bank_h - 9.0
        self.line(L + half + 18.0, sign_y, R - 18.0, sign_y, 0.5, DARK)
        self.text(cx, sign_y + 1.6, "Authorised Signatory", 8.4, True, "c")
        self.line(L + half, y, L + half, y + bank_h, 0.4, MID)
        y += bank_h
        self.line(L, y, R, y, 0.5, DARK)

        # --- computer generated ---
        self.text((L + R) / 2, y + 1.8, "This is a Computer Generated Invoice", 7.6, True, "c", SOFT)
        y += self.sc(6.0, 5.0)
        return y - start

    # -- per-page frame and contact footer -----------------------------------------------------------------------------------

    def draw_frame(self, number: int, count: int) -> None:
        self.rect(self.left, self.top, self.width_mm, self.frame_bottom - self.top, stroke=DARK, width=0.7)

    frame_bottom = 287.0

    def draw_page_footer(self) -> None:
        b = self.invoice.business
        phone, whatsapp, email = (b.get(k) or "" for k in ("footer_phone", "footer_whatsapp", "footer_email"))
        address = " ".join((b.get("footer_address") or "").split())
        if not (phone or whatsapp or email or address):
            return
        self.line(self.left, self.bottom, self.right, self.bottom, 0.5, DARK)
        items: list[tuple[list[str], str]] = []
        if phone and whatsapp and phone.strip() == whatsapp.strip():
            items.append((["call", "whatsapp"], phone))
        else:
            if phone:
                items.append((["call"], phone))
            if whatsapp:
                items.append((["whatsapp"], whatsapp))
        if email:
            items.append((["mail"], email))
        y = self.bottom + 2.4
        if items:
            size, icon_w, gap_item = 9.5, 3.6, 7.0
            widths = [len(icons) * (icon_w + 0.6) + 0.8 + self.tw(value, size, True) for icons, value in items]
            x = (self.left + self.right) / 2 - (sum(widths) + gap_item * (len(items) - 1)) / 2
            for (icons, value), width in zip(items, widths):
                for n, icon in enumerate(icons):
                    self._icon(icon, x + icon_w / 2 + n * (icon_w + 0.6), y + 1.9, icon_w)
                self.text(x + width - self.tw(value, size, True), y, value, size, True, "l", TEXT)
                x += width + gap_item
            y += 5.6
        if address:
            self.para((self.left + 4.0), y, address, self.width_mm - 8.0, 7.6, True, SOFT, "c")


TEMPLATES: dict[str, type[InvoiceTemplate]] = {CorporateTemplate.name: CorporateTemplate}
DEFAULT_TEMPLATE = CorporateTemplate.name
InvoicePDF = CorporateTemplate  # backwards-compatible name


def generate_invoice_pdf(
    invoice: InvoiceOut,
    target: Path,
    logo: Path | list[Path] | None = None,
    logo_heights: list[float] | None = None,
    template: str = DEFAULT_TEMPLATE,
) -> Path:
    return TEMPLATES[template](invoice, logo, logo_heights).build(target)
