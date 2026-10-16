// Renders an invoice (as returned by the API) to HTML that mirrors the A4 PDF layout.
import { esc, fmtDateNumeric, money, trimNumber } from "../utils.js";

const nl2br = (text) => esc(text).replace(/\n/g, "<br>");
const amount = (value) => money(value, { symbol: false });
const dec = (value) => Number(value);
const inr = (words) => (words ? "INR " + words.replace(/^Rupees\s+/, "") : "");

const stateLine = (party) => {
  const state = party.state || party.state_label;
  return state ? `State Name : ${esc(state)}${party.state_code ? `, Code : ${esc(party.state_code)}` : ""}` : "";
};

function taxGroups(inv) {
  const groups = new Map();
  for (const item of inv.items) {
    const key = String(item.gst_rate);
    const g = groups.get(key) || { hsn: item.hsn_sac || "-", rate: dec(item.gst_rate), taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    g.taxable += dec(item.taxable_amount);
    g.cgst += dec(item.cgst);
    g.sgst += dec(item.sgst);
    g.igst += dec(item.igst);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function renderInvoiceDocument(inv, { logoUrls = [], logoHeights = [] } = {}) {
  const b = inv.business;
  const c = inv.customer;
  const billing = c.billing_address || "";
  const shipping = c.shipping_address || billing;
  const phone = b.phone ? (String(b.phone).startsWith("+") ? b.phone : `+91-${b.phone}`) : "";

  const party = (label, address, withIds) => `
    <div class="d-cell">
      <div><b>${label}</b></div>
      <div><b>${esc(c.display_name)}</b></div>
      ${c.company_name && c.name && c.name !== c.company_name ? `<div>Attn: ${esc(c.name)}</div>` : ""}
      ${address ? `<div>${nl2br(address)}</div>` : ""}
      ${c.phone ? `<div>Phone: ${esc(c.phone)}</div>` : ""}
      ${withIds ? `<div><b>GSTIN/UIN: ${esc(c.gstin || "Unregistered")}</b></div>${stateLine(c) ? `<div><b>${stateLine(c)}</b></div>` : ""}` : ""}
    </div>`;

  const rows = inv.items.map((item, index) => `<tr class="d-item">
      <td class="c">${index + 1}</td>
      <td>${esc(item.part_no || "")}</td>
      <td><b>${esc(item.name)}</b>${item.description ? `<div class="d-desc">${esc(item.description)}</div>` : ""}</td>
      <td class="c">${esc(item.hsn_sac || "-")}</td>
      <td class="c">${trimNumber(item.gst_rate)}%</td>
      <td class="r">${trimNumber(item.quantity)}</td>
      <td class="r">${amount(item.rate)}</td>
      <td class="c">${esc(item.unit || "")}</td>
      <td class="r">${dec(item.discount) > 0 ? amount(item.discount) : "-"}</td>
      <td class="r">${amount(item.taxable_amount)}</td>
    </tr>`).join("");

  const rateGroups = taxGroups(inv).sort((x, y) => x.rate - y.rate);
  const pct = (rate) => `${trimNumber(String(rate))}%`;
  let taxLines;
  if (rateGroups.length <= 1) {  // one rate: show the invoice totals
    const rate = rateGroups.length ? rateGroups[0].rate : 0;
    taxLines = inv.is_interstate
      ? [[`OUTPUT IGST @ ${pct(rate)}`, amount(inv.igst)]]
      : [[`OUTPUT CGST @ ${pct(rate / 2)}`, amount(inv.cgst)], [`OUTPUT SGST @ ${pct(rate / 2)}`, amount(inv.sgst)]];
  } else if (inv.is_interstate) {
    taxLines = rateGroups.map((g) => [`OUTPUT IGST @ ${pct(g.rate)}`, amount(g.igst.toFixed(2))]);
  } else {
    taxLines = [
      ...rateGroups.map((g) => [`OUTPUT CGST @ ${pct(g.rate / 2)}`, amount(g.cgst.toFixed(2))]),
      ...rateGroups.map((g) => [`OUTPUT SGST @ ${pct(g.rate / 2)}`, amount(g.sgst.toFixed(2))]),
    ];
  }
  if (dec(inv.round_off) !== 0) {
    taxLines.push(["Round Off", `${dec(inv.round_off) > 0 ? "+" : "-"} ${amount(String(inv.round_off).replace("-", ""))}`]);
  }

  const groups = taxGroups(inv);
  const sum = (key) => groups.reduce((acc, g) => acc + g[key], 0);
  const fmt = (n) => amount(n.toFixed(2));
  const taxOf = (g) => (inv.is_interstate ? g.igst : g.cgst + g.sgst);
  const taxHead = `<tr><th rowspan="2" class="blank"></th><th rowspan="2">Taxable<br>Value</th><th colspan="2">Tax</th><th rowspan="2">Total<br>Tax Amount</th></tr><tr><th>Rate</th><th>Amount</th></tr>`;
  const taxRows = groups.map((g) => `<tr><td class="blank"></td><td class="r">${fmt(g.taxable)}</td><td class="r">${trimNumber(String(g.rate))}%</td><td class="r">${fmt(taxOf(g))}</td><td class="r">${fmt(taxOf(g))}</td></tr>`).join("");
  const totalTax = groups.reduce((acc, g) => acc + taxOf(g), 0);
  const taxTotal = `<tr class="tot"><td class="r">Total</td><td class="r">${fmt(sum("taxable"))}</td><td></td><td class="r">${fmt(totalTax)}</td><td class="r">${fmt(totalTax)}</td></tr>`;

  const bank = [
    ["A/c Holder", b.account_name || b.business_name], ["Bank", b.bank_name], ["A/c No.", b.account_number],
    ["IFSC", b.ifsc], ["UPI", b.upi_id],
  ];
  const hasBank = bank.slice(1).some(([, value]) => value);
  const taxWords = dec(inv.total_tax) > 0 ? inr(inv.tax_amount_in_words) : "INR Zero Only";
  const icon = (name) => `<img class="d-ico" src="assets/icons/${name}.svg" alt="">`;
  const icons = { call: icon("call"), whatsapp: icon("whatsapp"), mail: icon("mail") };
  const same = b.footer_phone && b.footer_phone.trim() === (b.footer_whatsapp || "").trim();
  const contactItems = [];
  if (same) contactItems.push([icons.call + icons.whatsapp, b.footer_phone]);
  else {
    if (b.footer_phone) contactItems.push([icons.call, b.footer_phone]);
    if (b.footer_whatsapp) contactItems.push([icons.whatsapp, b.footer_whatsapp]);
  }
  if (b.footer_email) contactItems.push([icons.mail, b.footer_email]);
  const contact = contactItems.map(([ico, text]) => `<span class="d-ci">${ico}${esc(text)}</span>`).join("");

  return `
  <div class="doc">
    <div class="d-logo-row">${logoUrls.length ? logoUrls.map((u, i) => `<img class="d-logo" src="${esc(u)}" alt="" style="max-height:${Number(logoHeights[i]) || 20}mm;max-width:calc(${(100 / logoUrls.length).toFixed(2)}% - 4mm)">`).join("") : `<div class="d-bizname">${esc(b.business_name)}</div>`}</div>
    <div class="d-frame">
      <div class="d-title">Tax Invoice</div>
      <div class="d-row">
        <div class="d-cell d-seller">
          <div><b>${esc(b.business_name)}</b></div>
          ${b.address ? `<div><b>${nl2br(b.address)}</b></div>` : ""}
          ${phone ? `<div><b>${esc(phone)}</b></div>` : ""}
          ${b.gstin ? `<div><b>GSTIN/UIN: ${esc(b.gstin)}</b></div>` : ""}
          ${stateLine(b) ? `<div><b>${stateLine(b)}</b></div>` : ""}
          ${b.email ? `<div><b>E-Mail : ${esc(b.email)}</b></div>` : ""}
        </div>
        <div class="d-meta">
          <div class="d-meta-row"><div><small>Invoice No.</small><b>${esc(inv.invoice_number)}</b></div><div><small>Dated</small><b>${fmtDateNumeric(inv.invoice_date)}</b></div></div>
          <div class="d-meta-row"><div><small>Place of Supply</small><b>${esc(inv.place_of_supply_label || inv.place_of_supply)}</b></div></div>
          <div class="d-meta-row d-ref"><div><b>Other Reference: ${esc(inv.other_reference || "-")}</b></div></div>
          <div class="d-meta-row d-ref"><div><b>Phone : ${esc(inv.contact_phone || "-")}</b></div></div>
          <div class="d-meta-row d-ref"><div><b>ESN: ${esc(inv.esn || "-")}</b></div></div>
        </div>
      </div>
      <div class="d-row d-parties">${party("Consignee", billing, true)}${party("Shipped To", shipping, false)}</div>

      <table class="d-items">
        <colgroup><col style="width:5.2%"><col style="width:13.4%"><col style="width:21.7%"><col style="width:9.3%"><col style="width:5.7%"><col style="width:8.2%"><col style="width:10.8%"><col style="width:5.2%"><col style="width:7.2%"><col style="width:13.4%"></colgroup>
        <thead><tr><th>S No</th><th class="l">Part No</th><th class="l">Description of Goods</th><th>HSN/SAC</th><th>GST %</th><th class="r">Quantity</th><th class="r">Rate</th><th>Per</th><th class="r">Disc.</th><th class="r">Amount</th></tr></thead>
        <tbody>
          ${rows}
          <tr class="d-fill"><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
          ${taxLines.map(([label, value]) => `<tr class="d-taxline"><td colspan="9" class="r"><b>${esc(label)}</b></td><td class="r">${value}</td></tr>`).join("")}
        </tbody>
        <tfoot><tr><td colspan="9" class="r"><b>Total</b></td><td class="r"><b>${money(inv.grand_total)}</b></td></tr></tfoot>
      </table>

      <div class="d-words"><div class="d-split"><span>Amount Chargeable (in words)</span><b>E. &amp; O.E</b></div><b>${esc(inr(inv.amount_in_words))}</b></div>
      <table class="d-tax"><colgroup><col style="width:48.5%"><col style="width:17.5%"><col style="width:10.3%"><col style="width:13.4%"><col style="width:10.3%"></colgroup><thead>${taxHead}</thead><tbody>${taxRows}${taxTotal}</tbody></table>

      <div class="d-row d-info">
        <div class="d-cell">
          <div><b>Tax Amount (in words) : ${esc(taxWords)}</b></div>
          <div><b>Company's PAN : ${esc(b.pan || "-")}</b></div>
          <div><b>Declaration:</b></div>
          <div>We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct</div>
        </div>
        <div class="d-cell">
          ${inv.notes ? `<div><b>Notes</b></div><div class="small">${nl2br(inv.notes)}</div>` : ""}
          ${inv.terms ? `<div><b>Terms &amp; Conditions</b></div><div class="small">${nl2br(inv.terms)}</div>` : ""}
        </div>
      </div>
      <div class="d-row d-bank">
        <div class="d-cell d-center">
          <div><b>Bank Details</b></div>
          ${hasBank ? bank.filter(([, v]) => v).map(([l, v]) => `<div>${l}: ${esc(v)}</div>`).join("") : "<div>Bank details not provided.</div>"}
        </div>
        <div class="d-cell d-sign"><div><b>for ${esc(b.business_name)}</b></div><div><b>Authorised Signatory</b></div></div>
      </div>
      <div class="d-cg">This is a Computer Generated Invoice</div>
    </div>
    <div class="d-strip">${contact ? `<div class="d-contact">${contact}</div>` : ""}${b.footer_address ? `<div class="d-addr">${esc(b.footer_address.replace(/\s+/g, " "))}</div>` : ""}</div>
    <div class="d-outline"></div>
    <div class="d-bar"></div>
  </div>`;
}
