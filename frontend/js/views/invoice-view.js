// Saved invoice: document preview, PDF download, payments and status changes.
import { api } from "../api.js";
import { getSettings } from "../store.js";
import { confirmDialog, openModal, setFieldError, toast, toastError, withBusy } from "../ui.js";
import { esc, fmtDate, icons, money, paise, paiseToString, statusPill } from "../utils.js";
import { fitDocument, renderInvoiceDocument } from "./invoice-doc.js";

/** Record-payment modal. Resolves with the updated invoice, or null. */
export function openPaymentForm(invoice) {
  return new Promise((resolve) => {
    let updated = null;
    const { el, close } = openModal({
      title: `Record payment · ${invoice.invoice_number}`,
      size: "sm",
      onClose: () => resolve(updated),
      body: `
        <form id="payment-form" novalidate>
          <p class="modal-text">Balance due: <b>${money(invoice.balance_due)}</b> of ${money(invoice.grand_total)}</p>
          <div class="field"><label class="req" for="pay-amount">Amount received (₹)</label>
            <input id="pay-amount" name="amount" inputmode="decimal" value="${esc(invoice.balance_due)}"></div>
        </form>`,
      footer: `<button type="button" class="btn" data-close>Cancel</button>
               <button type="submit" form="payment-form" class="btn btn-primary">Record payment</button>`,
    });
    const form = el.querySelector("#payment-form");
    form.amount.select();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = form.amount.value.trim();
      const amount = paise(value);
      form.querySelectorAll(".field-error").forEach((x) => x.remove());
      if (amount === null || amount <= 0n || !/^\d+(\.\d{1,2})?$/.test(value)) {
        setFieldError(form, "amount", "Enter a valid amount.");
        return;
      }
      if (amount > paise(invoice.balance_due)) {
        setFieldError(form, "amount", `Cannot exceed the balance of ${money(invoice.balance_due)}.`);
        return;
      }
      try {
        updated = await withBusy(el.querySelector('button[type="submit"]'), () => api.recordPayment(invoice.id, paiseToString(amount)));
        toast("Payment recorded", "success", `${money(value)} received against ${invoice.invoice_number}.`);
        close();
      } catch (error) { toastError(error); }
    });
  });
}

export async function render({ el, params, query, setTitle, navigate, isCurrent }) {
  const id = Number(params.id);
  const [inv, settings] = await Promise.all([api.invoice(id), getSettings({ fresh: true })]);
  if (!isCurrent()) return;
  setTitle(inv.invoice_number, `<a href="#/invoices">Invoices</a>`);

  const editable = ["Draft", "Pending", "Overdue"].includes(inv.status) && Number(inv.amount_paid) === 0;
  const canPay = ["Pending", "Partially Paid", "Overdue"].includes(inv.status);
  const created = query.created === "1";

  el.innerHTML = `
    ${created ? `<div class="banner banner-success">${icons.check}<div><b>Invoice ${esc(inv.invoice_number)} created successfully.</b> The A4 PDF has been generated and stored — download it from the panel on the right.</div></div>` : ""}
    ${inv.status === "Draft" ? `<div class="banner banner-warn">${icons.info}<div>This invoice is a <b>draft</b>. It is not counted in sales until you issue it.</div></div>` : ""}
    <div class="view-layout">
      <div class="doc-shell" data-fit-doc>${renderInvoiceDocument(inv, api.docOptions(settings))}</div>
      <div class="stack">
        <div class="card side-card">
          <div class="card-header"><h2>${esc(inv.invoice_number)}</h2>${statusPill(inv.status)}</div>
          <div class="kv"><span>Customer</span><span>${esc(inv.customer.display_name)}</span></div>
          <div class="kv"><span>Invoice date</span><span>${fmtDate(inv.invoice_date)}</span></div>
          <div class="kv"><span>Grand total</span><span>${money(inv.grand_total)}</span></div>
          <div class="kv"><span>Paid</span><span>${money(inv.amount_paid)}</span></div>
          <div class="kv"><span>Balance due</span><span>${money(inv.balance_due)}</span></div>
        </div>
        <div class="card">
          <div class="action-list">
            <a class="btn btn-primary btn-lg" href="${api.pdfUrl(id, true)}" download data-download>${icons.download}Download PDF</a>
            <a class="btn" href="${api.pdfUrl(id)}" target="_blank" rel="noopener">${icons.print}Print / open PDF</a>
            ${canPay ? `<button class="btn" data-pay>${icons.rupee}Record payment</button>
                        <button class="btn" data-paid>${icons.check}Mark as paid</button>` : ""}
            ${inv.status === "Draft" ? `<button class="btn" data-issue>${icons.check}Issue invoice</button>` : ""}
            ${editable ? `<a class="btn" href="#/invoices/${id}/edit">${icons.edit}Edit invoice</a>` : ""}
            <a class="btn" href="#/invoices/new?duplicate=${id}">${icons.copy}Duplicate</a>
            <button class="btn" data-regen data-busy="Regenerating…">${icons.doc}Regenerate PDF</button>
            ${inv.status !== "Cancelled" && Number(inv.amount_paid) === 0 ? `<button class="btn btn-danger" data-cancel>${icons.ban}Cancel invoice</button>` : ""}
            <button class="btn btn-danger" data-delete>${icons.trash}Delete invoice</button>
          </div>
        </div>
      </div>
    </div>`;

  fitDocument(el.querySelector(".doc-shell"));
  const reload = () => render({ el, params, query: {}, setTitle, navigate, isCurrent });
  const on = (selector, handler) => el.querySelector(selector)?.addEventListener("click", handler);

  on("[data-pay]", async () => { if (await openPaymentForm(inv)) reload(); });
  on("[data-paid]", async () => {
    const ok = await confirmDialog({ title: "Mark as paid?", message: `Record full payment of ${money(inv.balance_due)} for ${inv.invoice_number}?`, confirmText: "Mark as paid" });
    if (!ok) return;
    try { await api.setInvoiceStatus(id, "Paid"); toast("Invoice marked as paid", "success", `${inv.invoice_number} is now fully paid.`); reload(); } catch (e) { toastError(e); }
  });
  on("[data-issue]", async () => {
    try { await api.setInvoiceStatus(id, "Pending"); toast("Invoice issued", "success", `${inv.invoice_number} now counts towards your sales.`); reload(); } catch (e) { toastError(e); }
  });
  on("[data-cancel]", async () => {
    const ok = await confirmDialog({ title: "Cancel invoice?", message: `${inv.invoice_number} will be marked as cancelled and excluded from sales. This cannot be undone.`, confirmText: "Cancel invoice", danger: true });
    if (!ok) return;
    try { await api.setInvoiceStatus(id, "Cancelled"); toast("Invoice cancelled", "success", `${inv.invoice_number} is no longer counted in sales.`); reload(); } catch (e) { toastError(e); }
  });
  on("[data-delete]", async () => {
    const ok = await confirmDialog({ title: "Delete invoice?", message: `${inv.invoice_number} and its PDF will be permanently deleted. Consider cancelling instead to keep a record.`, confirmText: "Delete permanently", danger: true });
    if (!ok) return;
    try { await api.deleteInvoice(id); toast("Invoice deleted", "success", `${inv.invoice_number} and its PDF were removed.`); navigate("#/invoices"); } catch (e) { toastError(e); }
  });
  on("[data-regen]", async (event) => {
    try {
      await withBusy(event.currentTarget, () => api.regeneratePdf(id));
      toast("PDF generated", "success", `A fresh PDF for ${inv.invoice_number} is ready to download.`);
    } catch (e) { toastError(e); }
  });
}
