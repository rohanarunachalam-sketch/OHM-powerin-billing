// Renders an invoice (as returned by the API) to HTML that mirrors the A4 PDF layout (ModernTemplate in
// backend/pdf_generator.py). Every amount shown here comes from the backend; nothing is recalculated.
import { esc, fmtDate, money, trimNumber } from "../utils.js";

const nl2br = (text) => esc(text).replace(/\n/g, "<br>");
const amount = (value) => money(value, { symbol: false });
const rupees = (value) => money(value);
const dec = (value) => Number(value);
const inr = (words) => (words ? "INR " + words.replace(/^Rupees\s+/, "") : "");
const pct = (rate) => `${trimNumber(String(rate))}%`;

const stateLine = (party) => {
  const state = party.state || party.state_label;
  return state ? `State: ${esc(state)}${party.state_code ? ` (${esc(party.state_code)})` : ""}` : "";
};

/**
 * Scale the A4 document down to fit its container (never up). Mark the container with data-fit-doc to have it
 * re-fitted on window resize. Printing ignores the scale (see doc.css).
 */
export function fitDocument(shell) {
  const doc = shell.querySelector(".doc");
  if (!doc) return;
  let scaler = doc.parentElement;
  if (!scaler.classList.contains("doc-scale")) {
    const holder = document.createElement("div");
    holder.className = "doc-holder";
    scaler = document.createElement("div");
    scaler.className = "doc-scale";
    doc.replaceWith(holder);
    holder.appendChild(scaler);
    scaler.appendChild(doc);
  }
  const style = getComputedStyle(shell);
  const available = shell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const scale = Math.min(1, available / doc.offsetWidth);
  scaler.style.transform = `scale(${scale})`;
  scaler.style.width = `${doc.offsetWidth}px`;
  scaler.parentElement.style.width = `${doc.offsetWidth * scale}px`;
  scaler.parentElement.style.height = `${doc.offsetHeight * scale}px`;
}

window.addEventListener("resize", () => document.querySelectorAll("[data-fit-doc]").forEach(fitDocument), { passive: true });

const ICON_BASE = "assets/icons";
const contactIcon = (name) => `<img class="d-ico" src="${ICON_BASE}/${name}.svg" alt="">`;

export function renderInvoiceDocument(inv, { logoUrls = [], logoHeights = [] } = {}) {
  const b = inv.business;
  const c = inv.customer;
  const billing = c.billing_address || "";
  const shipping = c.shipping_address || "";
  const phone = b.phone ? (String(b.phone).startsWith("+") ? b.phone : `+91-${b.phone}`) : "";
  const hasDisc = inv.items.some((item) => dec(item.discount) > 0);
  const groups = [...(inv.tax_breakup || [])].sort((x, y) => dec(x.gst_rate) - dec(y.gst_rate));

  // ---- header ----
  const logos = logoUrls.map((u, i) => `<img class="d-logo" src="${esc(u)}" alt="" style="height:${Number(logoHeights[i]) || 20}mm">`).join("");
  const metaRows = [["Invoice No", inv.invoice_number, true], ["Invoice Date", fmtDate(inv.invoice_date), false]];
  if (inv.due_date) metaRows.push(["Due Date", fmtDate(inv.due_date), false]);
  if (inv.payment_terms) metaRows.push(["Payment Terms", inv.payment_terms, false]);
  for (const [label, value] of [["Other Reference", inv.other_reference], ["Phone", inv.contact_phone], ["ESN", inv.esn]]) {
    if (value) metaRows.push([label, value, false]);
  }

  // ---- parties ----
  const differentShip = shipping && shipping.trim() !== billing.trim();
  const billTo = `
    <div class="d-panel"><div class="d-label">BILL TO</div>
      <div class="d-pname">${esc(c.display_name)}</div>
      ${c.company_name && c.name ? `<div class="d-muted">Attn: ${esc(c.name)}</div>` : ""}
      ${billing ? `<div class="d-muted">${nl2br(billing)}</div>` : ""}
      ${c.phone ? `<div class="d-muted">Phone: ${esc(c.phone)}</div>` : ""}
      <div><b>GSTIN: ${esc(c.gstin || "Unregistered")}</b></div>
      ${stateLine(c) ? `<div class="d-muted">${stateLine(c)}</div>` : ""}
    </div>`;
  const second = differentShip
    ? `<div class="d-panel"><div class="d-label">SHIP TO</div><div class="d-pname">${esc(c.display_name)}</div><div class="d-muted">${nl2br(shipping)}</div></div>`
    : `<div class="d-panel"><div class="d-label">SUPPLY DETAILS</div>
        <div class="d-muted">Place of supply</div><div class="d-pname">${esc(inv.place_of_supply_label || inv.place_of_supply)}</div>
        <div class="d-muted">Supply type</div><div><b>${inv.is_interstate ? "Inter-state supply (IGST)" : "Intra-state supply (CGST + SGST)"}</b></div></div>`;

  // ---- items ----
  const rows = inv.items.map((item, index) => `<tr>
      <td class="c">${index + 1}</td>
      <td>${esc(item.part_no || "")}</td>
      <td><b>${esc(item.name)}</b>${item.description ? `<div class="d-desc">${esc(item.description)}</div>` : ""}</td>
      <td class="c">${esc(item.hsn_sac || "-")}</td>
      <td class="r">${esc(trimNumber(item.quantity))} ${esc(item.unit || "")}</td>
      <td class="r">${amount(item.rate)}</td>
      ${hasDisc ? `<td class="r">${dec(item.discount) > 0 ? amount(item.discount) : "-"}</td>` : ""}
      <td class="c">${pct(item.gst_rate)}</td>
      <td class="r"><b>${amount(item.taxable_amount)}</b></td>
    </tr>`).join("");
  const cols = hasDisc
    ? ["8mm", "25mm", "", "19mm", "20mm", "24mm", "16mm", "12mm", "28mm"]
    : ["8mm", "25mm", "", "19mm", "20mm", "24mm", "12mm", "28mm"];
  const head = ["#", "Part No", "Description", "HSN/SAC", "Qty", "Rate", ...(hasDisc ? ["Disc."] : []), "GST", "Amount"];
  const aligns = ["c", "l", "l", "c", "r", "r", ...(hasDisc ? ["r"] : []), "c", "r"];

  // ---- totals (backend values) ----
  const taxLines = [];
  if (groups.length <= 1) {
    const rate = groups.length ? dec(groups[0].gst_rate) : 0;
    if (inv.is_interstate) taxLines.push([`OUTPUT IGST @ ${pct(rate)}`, inv.igst]);
    else taxLines.push([`OUTPUT CGST @ ${pct(rate / 2)}`, inv.cgst], [`OUTPUT SGST @ ${pct(rate / 2)}`, inv.sgst]);
  } else if (inv.is_interstate) {
    groups.forEach((g) => taxLines.push([`OUTPUT IGST @ ${pct(g.gst_rate)}`, g.igst]));
  } else {
    groups.forEach((g) => taxLines.push([`OUTPUT CGST @ ${pct(dec(g.gst_rate) / 2)}`, g.cgst]));
    groups.forEach((g) => taxLines.push([`OUTPUT SGST @ ${pct(dec(g.gst_rate) / 2)}`, g.sgst]));
  }
  const totalRows = [
    ["Subtotal", rupees(inv.subtotal)],
    ...(dec(inv.discount) > 0 ? [["Discount", `- ${rupees(inv.discount)}`], ["Taxable Value", rupees(inv.taxable_amount)]] : []),
    ...taxLines.map(([label, value]) => [label, rupees(value)]),
    ...(dec(inv.round_off) !== 0 ? [["Round Off", `${dec(inv.round_off) > 0 ? "+" : "-"} ${rupees(String(inv.round_off).replace("-", ""))}`]] : []),
  ];

  // ---- GST summary (backend tax_breakup) ----
  const taxOf = (g) => (inv.is_interstate ? dec(g.igst) : dec(g.cgst) + dec(g.sgst));
  const sumTaxable = groups.reduce((acc, g) => acc + dec(g.taxable_amount), 0);
  const sumTax = groups.reduce((acc, g) => acc + taxOf(g), 0);
  const fmt = (n) => amount(n.toFixed(2));
  const summaryRows = groups.map((g) => `<tr><td class="blank"></td><td class="r">${amount(g.taxable_amount)}</td><td class="r">${pct(g.gst_rate)}</td><td class="r">${fmt(taxOf(g))}</td><td class="r">${fmt(taxOf(g))}</td></tr>`).join("");

  // ---- payment details / terms ----
  const bank = [["Account holder", b.account_name || b.business_name], ["Bank", b.bank_name], ["Branch", b.bank_branch], ["Account no.", b.account_number], ["IFSC", b.ifsc], ["UPI ID", b.upi_id]]
    .filter(([, value]) => value);
  const hasBank = ["bank_name", "account_number", "ifsc", "upi_id"].some((k) => b[k]);

  // ---- letterhead strip (call / WhatsApp / mail) ----
  const same = b.footer_phone && b.footer_phone.trim() === (b.footer_whatsapp || "").trim();
  const contactItems = [];
  if (same) contactItems.push([contactIcon("call") + contactIcon("whatsapp"), b.footer_phone]);
  else {
    if (b.footer_phone) contactItems.push([contactIcon("call"), b.footer_phone]);
    if (b.footer_whatsapp) contactItems.push([contactIcon("whatsapp"), b.footer_whatsapp]);
  }
  if (b.footer_email) contactItems.push([contactIcon("mail"), b.footer_email]);
  const contact = contactItems.map(([ico, text]) => `<span class="d-ci">${ico}${esc(text)}</span>`).join("");

  return `
  <div class="doc">
    ${logos ? `<div class="d-logos">${logos}</div>` : ""}
    <div class="d-head">
      <div class="d-seller">
        <div class="d-biz" style="${logos ? "" : "font-size:16pt"}">${esc(b.business_name)}</div>
        ${b.address ? `<div class="d-muted">${nl2br(b.address)}</div>` : ""}
        ${phone ? `<div class="d-muted">Phone: ${esc(phone)}</div>` : ""}
        ${b.email ? `<div class="d-muted">Email: ${esc(b.email)}</div>` : ""}
        ${b.gstin ? `<div><b>GSTIN: ${esc(b.gstin)}</b></div>` : ""}
        ${stateLine(b) ? `<div class="d-muted">${stateLine(b)}</div>` : ""}
      </div>
      <div class="d-title">
        ${metaRows.map(([label, value, bold]) => `<div class="d-meta-row"><span>${label}</span>${bold ? `<b>${esc(value)}</b>` : `<span class="v">${esc(value)}</span>`}</div>`).join("")}
      </div>
    </div>

    <div class="d-parties">${billTo}${second}</div>

    <table class="d-items">
      <colgroup>${cols.map((w) => `<col${w ? ` style="width:${w}"` : ""}>`).join("")}</colgroup>
      <thead><tr>${head.map((h, i) => `<th class="${aligns[i]}">${h}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="d-totals-row">
      <div class="d-words">
        <div class="d-label">AMOUNT IN WORDS</div>
        <div class="d-words-text">${esc(inr(inv.amount_in_words))}</div>
      </div>
      <div class="d-totals">
        ${totalRows.map(([label, value]) => `<div class="d-tr${label === "Round Off" ? " muted" : ""}"><span>${esc(label)}</span><span>${value}</span></div>`).join("")}
        <div class="d-grand"><span>TOTAL</span><span>${rupees(inv.grand_total)}</span></div>
      </div>
    </div>

    <table class="d-tax">
      <colgroup><col style="width:44.3%"><col style="width:17.5%"><col style="width:10.3%"><col style="width:13.4%"><col style="width:10.3%"></colgroup>
      <thead>
        <tr><th rowspan="2" class="l">GST SUMMARY</th><th rowspan="2">Taxable<br>Value</th><th colspan="2">Tax</th><th rowspan="2">Total<br>Tax Amount</th></tr>
        <tr><th>Rate</th><th>Amount</th></tr>
      </thead>
      <tbody>${summaryRows}
        <tr class="tot"><td class="r">Total</td><td class="r">${fmt(sumTaxable)}</td><td></td><td class="r">${fmt(sumTax)}</td><td class="r">${fmt(sumTax)}</td></tr>
      </tbody>
    </table>
    ${dec(inv.total_tax) > 0 ? `<div class="d-muted d-taxwords">Tax amount in words: ${esc(inr(inv.tax_amount_in_words))}</div>` : ""}

    <div class="d-cols">
      <div>${hasBank ? `<div class="d-label">PAYMENT DETAILS</div>${bank.map(([label, value]) => `<div class="d-kv"><span>${label}</span><b>${esc(value)}</b></div>`).join("")}` : ""}</div>
      <div>
        ${inv.terms ? `<div class="d-label">TERMS &amp; CONDITIONS</div><div class="d-pre">${nl2br(inv.terms)}</div>` : ""}
        ${inv.notes ? `<div class="d-label">NOTES</div><div class="d-pre">${nl2br(inv.notes)}</div>` : ""}
      </div>
    </div>

    <div class="d-sign">
      <div class="d-decl"><div class="d-muted">Declaration: We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.${b.pan ? `  Company's PAN: ${esc(b.pan)}` : ""}</div>
        <div class="d-thanks">Thank you for doing business with ${esc(b.business_name || "us")}.</div></div>
      <div class="d-sign-box"><div class="d-for">for ${esc(b.business_name)}</div><div class="d-sign-line">Authorised Signatory</div></div>
    </div>
    <div class="d-cg">This is a Computer Generated Invoice</div>

    <div class="d-strip">${contact ? `<div class="d-contact">${contact}</div>` : ""}${b.footer_address ? `<div class="d-addr">${esc(b.footer_address.replace(/\s+/g, " "))}</div>` : ""}</div>
    <div class="d-outline"></div>
    <div class="d-bar"></div>
  </div>`;
}
