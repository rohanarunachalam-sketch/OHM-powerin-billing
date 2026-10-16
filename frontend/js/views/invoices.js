import { api } from "../api.js";
import { getMeta } from "../store.js";
import { emptyState, searchBox } from "../ui.js";
import { debounce, esc, fmtDate, icons, money, statusPill } from "../utils.js";

const PAGE_SIZE = 50;

export function invoiceRows(items, { showBalance = false } = {}) {
  return items.map((i) => `
    <tr class="clickable" data-href="#/invoices/${i.id}">
      <td class="strong">${esc(i.invoice_number)}</td>
      <td>${esc(i.customer_name)}</td>
      <td class="hide-sm nowrap">${fmtDate(i.invoice_date)}</td>
      <td class="num strong">${money(i.grand_total)}</td>
      ${showBalance ? `<td class="num">${money(i.balance_due)}</td>` : ""}
      <td>${statusPill(i.status)}</td>
      <td class="actions">
        <a class="icon-btn" href="#/invoices/${i.id}" title="View" aria-label="View">${icons.eye}</a>
        <a class="icon-btn" href="${api.pdfUrl(i.id, true)}" download title="Download PDF" aria-label="Download PDF" data-stop>${icons.download}</a>
      </td>
    </tr>`).join("");
}

export function invoiceTable(items, opts = {}) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Invoice No</th><th>Customer</th><th class="hide-sm">Date</th><th class="num">Amount</th>${opts.showBalance ? '<th class="num">Balance</th>' : ""}<th>Status</th><th class="actions">Action</th></tr></thead>
    <tbody>${invoiceRows(items, opts)}</tbody></table></div>`;
}

/** Row click navigates; links inside rows keep their own behaviour. */
export function bindRowLinks(container) {
  container.addEventListener("click", (event) => {
    if (event.target.closest("a, button")) return;
    const row = event.target.closest("tr[data-href]");
    if (row) location.hash = row.dataset.href;
  });
}

export async function render({ el, setTitle, query, isCurrent }) {
  setTitle("Invoices", "Sales");
  const { statuses } = await getMeta();
  el.innerHTML = `
    <div class="page-head">
      <div><p>All invoices with their payment status.</p></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/invoices/new">${icons.plus}New Invoice</a></div>
    </div>
    <div class="card">
      <div class="toolbar">
        ${searchBox("Search invoice number or customer", query.q || "")}
        <select data-status aria-label="Status"><option value="">All statuses</option>${statuses.map((s) => `<option${s === query.status ? " selected" : ""}>${s}</option>`).join("")}</select>
        <input type="date" data-from aria-label="From date" title="From date">
        <input type="date" data-to aria-label="To date" title="To date">
        <button class="btn btn-ghost btn-sm" data-clear>Clear</button>
        <span class="result-count" data-count></span>
      </div>
      <div data-list><div class="loading"><span class="spinner"></span>Loading…</div></div>
      <div class="items-footer" data-more hidden><button class="btn btn-sm" data-load-more>Load more</button></div>
    </div>`;

  const listEl = el.querySelector("[data-list]");
  const search = el.querySelector("[data-search]");
  const status = el.querySelector("[data-status]");
  const from = el.querySelector("[data-from]");
  const to = el.querySelector("[data-to]");
  let items = [];

  async function load(append = false) {
    const filters = { q: search.value.trim(), status: status.value, date_from: from.value, date_to: to.value };
    const page = await api.invoices({ ...filters, limit: PAGE_SIZE, offset: append ? items.length : 0 });
    if (!isCurrent()) return;
    items = append ? items.concat(page.items) : page.items;
    el.querySelector("[data-count]").textContent = `${page.total} invoice${page.total === 1 ? "" : "s"}`;
    el.querySelector("[data-more]").hidden = items.length >= page.total;
    const filtered = Object.values(filters).some(Boolean);
    listEl.innerHTML = items.length
      ? invoiceTable(items)
      : filtered
        ? emptyState({ icon: icons.search, title: "No invoices match", text: "Try a different search or clear the filters." })
        : emptyState({
            title: "No invoices yet", text: "Create your first GST invoice in under a minute.",
            actionHtml: `<a class="btn btn-primary" href="#/invoices/new">${icons.plus}Create Invoice</a>`,
          });
  }

  const reload = debounce(() => load(), 250);
  search.addEventListener("input", reload);
  [status, from, to].forEach((input) => input.addEventListener("change", () => load()));
  el.querySelector("[data-clear]").addEventListener("click", () => {
    search.value = ""; status.value = ""; from.value = ""; to.value = "";
    load();
  });
  el.querySelector("[data-load-more]").addEventListener("click", () => load(true));
  bindRowLinks(listEl);
  await load();
}
