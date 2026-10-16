"""Invoice arithmetic: line amounts, Indian GST split, round-off and amount in words.

All money is handled as Decimal and rounded half-up to paise. These functions are
the single source of truth for invoice values; the frontend mirrors them only for
live feedback while typing.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

ZERO = Decimal("0")
PAISE = Decimal("0.01")
RUPEE = Decimal("1")
HUNDRED = Decimal("100")

# GST slabs. 12% and 28% are kept alongside the current slabs for older goods/invoices.
ALLOWED_GST_RATES: tuple[Decimal, ...] = tuple(
    Decimal(r) for r in ("0", "0.25", "3", "5", "12", "18", "28", "40")
)


def to_money(value: Decimal) -> Decimal:
    return Decimal(value).quantize(PAISE, rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class LineInput:
    quantity: Decimal
    rate: Decimal
    gst_rate: Decimal
    discount_type: str = "percent"  # "percent" | "amount"
    discount_value: Decimal = ZERO


@dataclass(frozen=True)
class LineResult:
    gross_amount: Decimal
    discount: Decimal
    taxable_amount: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal
    tax_amount: Decimal
    amount: Decimal


@dataclass
class TaxBreakup:
    gst_rate: Decimal
    taxable_amount: Decimal = ZERO
    cgst: Decimal = ZERO
    sgst: Decimal = ZERO
    igst: Decimal = ZERO


@dataclass
class InvoiceTotals:
    lines: list[LineResult]
    subtotal: Decimal
    discount: Decimal
    taxable_amount: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal
    total_tax: Decimal
    round_off: Decimal
    grand_total: Decimal
    amount_in_words: str
    is_interstate: bool
    tax_breakup: list[TaxBreakup] = field(default_factory=list)


class CalculationError(ValueError):
    """Raised for inputs that cannot produce a valid invoice line."""


def calculate_line(line: LineInput, is_interstate: bool) -> LineResult:
    if line.quantity <= ZERO:
        raise CalculationError("Quantity must be greater than zero.")
    if line.rate < ZERO:
        raise CalculationError("Rate cannot be negative.")
    if line.gst_rate not in ALLOWED_GST_RATES:
        raise CalculationError(f"GST rate {line.gst_rate}% is not a valid GST slab.")
    if line.discount_value < ZERO:
        raise CalculationError("Discount cannot be negative.")

    gross = to_money(line.quantity * line.rate)

    if line.discount_type == "percent":
        if line.discount_value > HUNDRED:
            raise CalculationError("Discount percentage cannot exceed 100%.")
        discount = to_money(gross * line.discount_value / HUNDRED)
    elif line.discount_type == "amount":
        discount = to_money(line.discount_value)
    else:
        raise CalculationError("Unknown discount type.")
    if discount > gross:
        raise CalculationError("Discount cannot be more than the line amount.")

    taxable = gross - discount
    if is_interstate:
        igst = to_money(taxable * line.gst_rate / HUNDRED)
        cgst = sgst = ZERO
    else:
        # CGST and SGST are each half the GST rate, computed (and rounded) separately.
        cgst = sgst = to_money(taxable * line.gst_rate / (2 * HUNDRED))
        igst = ZERO
    tax = cgst + sgst + igst
    return LineResult(
        gross_amount=gross,
        discount=discount,
        taxable_amount=taxable,
        cgst=cgst,
        sgst=sgst,
        igst=igst,
        tax_amount=tax,
        amount=taxable + tax,
    )


def calculate_invoice(lines: list[LineInput], is_interstate: bool) -> InvoiceTotals:
    if not lines:
        raise CalculationError("An invoice needs at least one item.")

    results: list[LineResult] = []
    breakup: dict[Decimal, TaxBreakup] = {}
    for index, line in enumerate(lines, start=1):
        try:
            result = calculate_line(line, is_interstate)
        except CalculationError as exc:
            raise CalculationError(f"Item {index}: {exc}") from exc
        results.append(result)
        bucket = breakup.setdefault(line.gst_rate, TaxBreakup(gst_rate=line.gst_rate))
        bucket.taxable_amount += result.taxable_amount
        bucket.cgst += result.cgst
        bucket.sgst += result.sgst
        bucket.igst += result.igst

    subtotal = sum((r.gross_amount for r in results), ZERO)
    discount = sum((r.discount for r in results), ZERO)
    taxable = sum((r.taxable_amount for r in results), ZERO)
    cgst = sum((r.cgst for r in results), ZERO)
    sgst = sum((r.sgst for r in results), ZERO)
    igst = sum((r.igst for r in results), ZERO)
    total_tax = cgst + sgst + igst

    exact_total = taxable + total_tax
    grand_total = exact_total.quantize(RUPEE, rounding=ROUND_HALF_UP)
    round_off = grand_total - exact_total

    return InvoiceTotals(
        lines=results,
        subtotal=to_money(subtotal),
        discount=to_money(discount),
        taxable_amount=to_money(taxable),
        cgst=to_money(cgst),
        sgst=to_money(sgst),
        igst=to_money(igst),
        total_tax=to_money(total_tax),
        round_off=to_money(round_off),
        grand_total=to_money(grand_total),
        amount_in_words=amount_in_words(grand_total),
        is_interstate=is_interstate,
        tax_breakup=sorted(breakup.values(), key=lambda b: b.gst_rate),
    )


# ---------------------------------------------------------------------------
# Amount in words (Indian numbering system)
# ---------------------------------------------------------------------------

_ONES = (
    "Zero One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen "
    "Fourteen Fifteen Sixteen Seventeen Eighteen Nineteen"
).split()
_TENS = "_ _ Twenty Thirty Forty Fifty Sixty Seventy Eighty Ninety".split()


def _below_hundred(n: int) -> str:
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    return _TENS[tens] + (f" {_ONES[ones]}" if ones else "")


def _below_thousand(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    parts = []
    if hundreds:
        parts.append(f"{_ONES[hundreds]} Hundred")
    if rest:
        parts.append(_below_hundred(rest))
    return " ".join(parts)


def number_to_indian_words(n: int) -> str:
    """Convert a non-negative integer to words using Thousand / Lakh / Crore."""
    if n < 0:
        raise ValueError("Negative numbers are not supported.")
    if n == 0:
        return "Zero"

    crore, n = divmod(n, 10_000_000)
    lakh, n = divmod(n, 100_000)
    thousand, n = divmod(n, 1_000)

    parts = []
    if crore:
        # 100+ crore is expressed recursively, e.g. "One Hundred Twenty Crore".
        parts.append(f"{number_to_indian_words(crore)} Crore")
    if lakh:
        parts.append(f"{_below_hundred(lakh)} Lakh")
    if thousand:
        parts.append(f"{_below_hundred(thousand)} Thousand")
    if n:
        parts.append(_below_thousand(n))
    return " ".join(parts)


def amount_in_words(amount: Decimal) -> str:
    amount = to_money(amount)
    if amount < ZERO:
        raise ValueError("Amount cannot be negative.")
    rupees = int(amount)
    paise = int((amount - rupees) * 100)
    words = f"Rupees {number_to_indian_words(rupees)}"
    if paise:
        words += f" and {number_to_indian_words(paise)} Paise"
    return words + " Only"
