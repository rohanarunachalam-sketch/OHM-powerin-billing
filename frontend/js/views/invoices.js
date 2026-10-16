import { api } from "../api.js";
import { getMeta } from "../store.js";
import {
  actionMenu, bindMenus, confirmDialog, emptyState, searchBox, skeletonTable, toast, toastError,
} from "../ui.js";
import { debounce, esc, fmtDate, icons, money, statusPill } from "../utils.js";
import { openPaymentForm } from "./invoice-view.js";

const PAGE_SIZE = 50;
const EDITABLE = ["Draft", "Pending", "Overdue"];
const PAYABLE = ["Pending", "Partially Paid", "Overdue"];

/** Row actions shown for an invoice summary. Only actions the application supports are offered. */
function rowMenu(i) {
  const paid = Number(i.amount_paid) > 0;
  return actionMenu([
    { label: "View", icon: "eye", href: `#/invoices/${i.id}` },
    EDITABLE.includes(i.status) && !paid && { label: "Edit", icon: "edit", href: `#/invoices/${i.id}/edit` },
    { label: "Duplicate", icon: "copy", href: `#/invoices/new?duplicate=${i.id}` },
    { sep: true },
    { label: "Download PDF", icon: "download", href: api.pdfUrl(i.id, true), download: true },
    { label: "Print", icon: "print", href: api.pdfUrl(i.id), blank: true },
    PAYABLE.includes(i.status) && { label: "Record payment", icon: "rupee", action: `pay:${i.id}` },
    i.status !== "Cancelled" && !paid && { sep: true },
    i.status !== "Cancelled" && !paid && { label: "Cancel invoice", icon: "ban", action: `cancel:${i.id}`, danger: true },
  ], { label: `Actions for ${i.invoice_number}` });
}

export function invoiceRows(items, { showBalance = false, menu = true, compact = false } = {}) {
  return items.map((i) => `
    <tr class="clickable" data-href="#/invoices/${i.id}">
      <td class="strong"><a href="#/invoices/${i.id}" style="color:inherit">${esc(i.invoice_number)}</a></td>
      <td>${esc(i.customer_name)}</td>
      ${compact ? "" : `<td class="hide-sm nowrap">${fmtDate(i.invoice_date)}</td>
      <td class="hide-sm nowrap">${i.status === "Draft" ? '<span class="sub">—</span>' : fmtDate(i.due_date)}</td>`}
      <td class="num strong">${money(i.grand_total)}</td>
      ${showBalance ? `<td class="num ${Number(i.balance_due) > 0 ? "balance-pos" : "balance-zero"}">${money(i.balance_due)}</td>` : ""}
      <td>${statusPill(i.status)}</td>
      ${menu ? `<td class="actions">${rowMenu(i)}</td>` : ""}
    </tr>`).join("");
}

export function invoiceTable(items, opts = {}) {
  const { menu = true, showBalance = false, compact = false } = opts;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th>${compact ? "" : '<th scope="col" class="hide-sm">Date</th><th scope="col" class="hide-sm">Due date</th>'}<th scope="col" class="num">Amount</th>${showBalance ? '<th scope="col" class="num">Balance</th>' : ""}<th scope="col">Status</th>${menu ? '<th scope="col" class="actions"><span class="sr-only">Actions</span></th>' : ""}</tr></thead>
    <tbody>${invoiceRows(items, opts)}</tbody></table></div>`;
}

/**
 * Wire row clicks and the three-dot menu inside `container`.
 * `items()` returns the invoices currently shown; `reload()` refreshes the view after a change.
 */
export function bindInvoiceList(container, { items, reload }) {
  bindMenus(container);
  container.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (action) {
      const [name, id] = action.dataset.action.split(":");
      const invoice = items().find((i) => String(i.id) === id);
      if (!invoice) return;
      if (name === "pay") {
        if (await openPaymentForm(invoice)) reload();
      } else if (name === "cancel") {
        const ok = await confirmDialog({
          title: "Cancel invoice?",
          message: `${invoice.invoice_number} will be marked as cancelled and excluded from sales. This cannot be undone.`,
          confirmText: "Cancel invoice", danger: true,
        });
        if (!ok) return;
        try {
          await api.setInvoiceStatus(invoice.id, "Cancelled");
          toast("Invoice cancelled", "success", `${invoice.invoice_number} is no longer counted in sales.`);
          reload();
        } catch (error) { toastError(error); }
      }
      return;
    }
    if (event.target.closest("a, button, .menu")) return;
    const row = event.target.closest("tr[data-href]");
    if (row) location.hash = row.dataset.href;
  });
}

/** Kept for views that only need clickable rows. */
export function bindRowLinks(container) {
  container.addEventListener("click", (event) => {
    if (event.target.closest("a, button, .menu")) return;
    const row = event.target.closest("tr[data-href]");
    if (row) location.hash = row.dataset.href;
  });
}

export async function render({ el, setTitle, query, isCurrent }) {
  setTitle("Invoices");
  const { statuses } = await getMeta();
  let activeStatus = statuses.includes(query.status) ? query.status : "";

  el.innerHTML = `
    <div class="page-head">
      <div><h2>Invoices</h2><p>Manage and track all your invoices.</p></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/invoices/new">${icons.plus}Create Invoice</a></div>
    </div>
    <div class="card">
      <div class="chips" role="group" aria-label="Filter by status" data-chips></div>
      <div class="toolbar">
        ${searchBox("Search invoice, customer...", query.q || "")}
        <input type="date" data-from aria-label="From date" title="From date">
        <input type="date" data-to aria-label="To date" title="To date">
        <button class="btn btn-ghost btn-sm" data-clear>Clear filters</button>
        <span class="result-count" data-count></span>
      </div>
      <div data-list>${skeletonTable(7)}</div>
      <div class="items-footer" data-more hidden><button class="btn btn-sm" data-load-more>Load more</button></div>
    </div>`;

  const listEl = el.querySelector("[data-list]");
  const chipsEl = el.querySelector("[data-chips]");
  const search = el.querySelector("[data-search]");
  const from = el.querySelector("[data-from]");
  const to = el.querySelector("[data-to]");
  let items = [];
  let counts = {};

  const renderChips = () => {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const chip = (label, value, n) => `<button type="button" class="chip" data-status="${esc(value)}" aria-pressed="${value === activeStatus}">${esc(label)}${n === undefined ? "" : ` <span class="n">${n}</span>`}</button>`;
    chipsEl.innerHTML = chip("All", "", counts && Object.keys(counts).length ? total : undefined) +
      statuses.map((s) => chip(s, s, counts[s] ?? 0)).join("");
  };

  async function loadCounts() {
    try {
      counts = (await api.dashboard()).status_counts || {};
      if (isCurrent()) renderChips();
    } catch { /* chips still work without counts */ }
  }

  async function load(append = false) {
    const filters = { q: search.value.trim(), status: activeStatus, date_from: from.value, date_to: to.value };
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
            icon: icons.doc, title: "No invoices yet", text: "Create your first invoice and start tracking your sales.",
            actionHtml: `<a class="btn btn-primary" href="#/invoices/new">${icons.plus}Create Invoice</a>`,
          });
  }

  const reload = () => { load(); loadCounts(); };
  const debouncedLoad = debounce(() => load(), 250);
  search.addEventListener("input", debouncedLoad);
  [from, to].forEach((input) => input.addEventListener("change", () => load()));
  chipsEl.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-status]");
    if (!chip) return;
    activeStatus = chip.dataset.status;
    renderChips();
    load();
  });
  el.querySelector("[data-clear]").addEventListener("click", () => {
    search.value = ""; from.value = ""; to.value = ""; activeStatus = "";
    renderChips();
    load();
  });
  el.querySelector("[data-load-more]").addEventListener("click", () => load(true));
  bindInvoiceList(listEl, { items: () => items, reload });
  renderChips();
  await Promise.all([load(), loadCounts()]);
}
