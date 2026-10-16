import { api } from "../api.js";
import { emptyState } from "../ui.js";
import { esc, fmtDate, icons, money, statusPill } from "../utils.js";
import { openPaymentForm } from "./invoice-view.js";
import { bindRowLinks, invoiceTable } from "./invoices.js";

export async function render({ el, setTitle, isCurrent }) {
  setTitle("Payments", "Money");
  el.innerHTML = `
    <div class="page-head"><div><p>Outstanding invoices and payments received.</p></div></div>
    <div class="card">
      <div class="card-header"><div><h2>Awaiting payment</h2><p>Pending, partially paid and overdue invoices.</p></div></div>
      <div data-open><div class="loading"><span class="spinner"></span>Loading…</div></div>
    </div>
    <div class="card">
      <div class="card-header"><div><h2>Paid invoices</h2></div></div>
      <div data-paid><div class="loading"><span class="spinner"></span>Loading…</div></div>
    </div>`;

  async function load() {
    const [open, paid] = await Promise.all([
      api.invoices({ status: "open", limit: 200 }),
      api.invoices({ status: "Paid", limit: 50 }),
    ]);
    if (!isCurrent()) return;
    const openEl = el.querySelector("[data-open]");
    openEl.innerHTML = open.items.length
      ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Invoice No</th><th>Customer</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th><th class="actions"></th></tr></thead>
          <tbody>${open.items.map((i) => `
            <tr class="clickable" data-href="#/invoices/${i.id}">
              <td class="strong">${esc(i.invoice_number)}</td><td>${esc(i.customer_name)}</td>
              <td class="num">${money(i.grand_total)}</td>
              <td class="num strong">${money(i.balance_due)}</td><td>${statusPill(i.status)}</td>
              <td class="actions"><button class="btn btn-sm" data-pay="${i.id}">${icons.rupee}Record payment</button></td>
            </tr>`).join("")}</tbody></table></div>`
      : emptyState({ icon: icons.check, title: "All caught up", text: "No invoices are awaiting payment." });
    openEl._items = open.items;

    el.querySelector("[data-paid]").innerHTML = paid.items.length
      ? invoiceTable(paid.items)
      : emptyState({ icon: icons.rupee, title: "No paid invoices yet", text: "Invoices you mark as paid appear here." });
  }

  el.addEventListener("click", async (event) => {
    const pay = event.target.closest("[data-pay]");
    if (!pay) return;
    const summary = el.querySelector("[data-open]")._items.find((i) => String(i.id) === pay.dataset.pay);
    if (await openPaymentForm(summary)) load();
  });
  bindRowLinks(el);
  await load();
}
