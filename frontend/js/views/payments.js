import { api } from "../api.js";
import { emptyState, skeletonStats, skeletonTable, toastError } from "../ui.js";
import { esc, fmtDate, icons, money, statusPill } from "../utils.js";
import { openPaymentForm } from "./invoice-view.js";
import { bindRowLinks } from "./invoices.js";

// Payments are recorded against invoices (invoice total, amount paid, balance), so this page is invoice-centred.
function paymentRows(items, { action }) {
  return items.map((i) => {
    const owed = Number(i.balance_due) > 0;
    return `<tr class="clickable" data-href="#/invoices/${i.id}">
      <td class="strong"><a href="#/invoices/${i.id}" style="color:inherit">${esc(i.invoice_number)}</a></td>
      <td>${esc(i.customer_name)}</td>
      <td class="hide-sm nowrap">${fmtDate(i.invoice_date)}</td>
      <td class="num">${money(i.grand_total)}</td>
      <td class="num">${money(i.amount_paid)}</td>
      <td class="num ${owed ? "balance-pos" : "balance-zero"}">${money(i.balance_due)}</td>
      <td>${statusPill(i.status)}</td>
      <td class="actions">${action ? `<button class="btn btn-sm" data-pay="${i.id}">${icons.rupee}Record payment</button>` : ""}</td>
    </tr>`;
  }).join("");
}

const paymentTable = (items, opts) => `<div class="table-wrap"><table class="table">
  <thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col" class="hide-sm">Date</th><th scope="col" class="num">Invoice total</th><th scope="col" class="num">Paid</th><th scope="col" class="num">Balance</th><th scope="col">Status</th><th scope="col" class="actions"><span class="sr-only">Actions</span></th></tr></thead>
  <tbody>${paymentRows(items, opts)}</tbody></table></div>`;

export async function render({ el, setTitle, isCurrent }) {
  setTitle("Payments");
  el.innerHTML = `
    <div class="page-head"><div><h2>Payments</h2><p>Track what has been received and what is still outstanding.</p></div></div>
    <div data-kpis>${skeletonStats(3)}</div>
    <div class="card">
      <div class="card-header"><div><h2>Awaiting payment</h2><p>Pending, partially paid and overdue invoices.</p></div></div>
      <div data-open>${skeletonTable(4)}</div>
    </div>
    <div class="card">
      <div class="card-header"><div><h2>Paid invoices</h2><p>Most recent fully paid invoices.</p></div></div>
      <div data-paid>${skeletonTable(3)}</div>
    </div>`;

  let openItems = [];
  async function load() {
    try {
      const [open, paid, d] = await Promise.all([
        api.invoices({ status: "open", limit: 200 }),
        api.invoices({ status: "Paid", limit: 50 }),
        api.dashboard(),
      ]);
      if (!isCurrent()) return;
      openItems = open.items;
      el.querySelector("[data-kpis]").innerHTML = `<div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="card stat paid"><div class="stat-label">Received<span class="stat-icon">${icons.checkCircle}</span></div><div class="stat-value">${money(d.paid, { decimals: 0 })}</div><div class="stat-meta">${d.paid_percent === null ? "No sales yet" : `<b>${d.paid_percent}%</b> of sales collected`}</div></div>
        <div class="card stat pending"><div class="stat-label">Outstanding<span class="stat-icon">${icons.clock}</span></div><div class="stat-value">${money(d.outstanding, { decimals: 0 })}</div><div class="stat-meta">${d.outstanding_count} invoice${d.outstanding_count === 1 ? "" : "s"} awaiting payment</div></div>
        <div class="card stat overdue"><div class="stat-label">Overdue<span class="stat-icon">${icons.alert}</span></div><div class="stat-value">${money(d.overdue, { decimals: 0 })}</div><div class="stat-meta">${d.overdue_count} invoice${d.overdue_count === 1 ? "" : "s"} past due</div></div>
      </div>`;
      el.querySelector("[data-open]").innerHTML = open.items.length
        ? paymentTable(open.items, { action: true })
        : emptyState({ icon: icons.checkCircle, title: "All caught up", text: "No invoices are awaiting payment." });
      el.querySelector("[data-paid]").innerHTML = paid.items.length
        ? paymentTable(paid.items, { action: false })
        : emptyState({ icon: icons.wallet, title: "No paid invoices yet", text: "Invoices that are fully paid appear here." });
    } catch (error) { toastError(error); }
  }

  el.addEventListener("click", async (event) => {
    const pay = event.target.closest("[data-pay]");
    if (!pay) return;
    const summary = openItems.find((i) => String(i.id) === pay.dataset.pay);
    if (summary && await openPaymentForm(summary)) load();
  });
  bindRowLinks(el);
  await load();
}
