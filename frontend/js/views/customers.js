import { api } from "../api.js";
import { confirmDialog, emptyState, openModal, searchBox, toast, toastError } from "../ui.js";
import { debounce, esc, fmtDate, icons, money, statusPill } from "../utils.js";
import { openCustomerForm } from "./forms.js";

export async function render({ el, setTitle, query, isCurrent }) {
  setTitle("Customers", "Sales");
  el.innerHTML = `
    <div class="page-head">
      <div><p>Manage the people and businesses you bill.</p></div>
      <div class="page-actions"><button class="btn btn-primary" data-new>${icons.plus}New Customer</button></div>
    </div>
    <div class="card">
      <div class="toolbar">${searchBox("Search by name, company, GSTIN, phone or email", query.q || "")}<span class="result-count" data-count></span></div>
      <div data-list><div class="loading"><span class="spinner"></span>Loading…</div></div>
    </div>`;

  const listEl = el.querySelector("[data-list]");
  const countEl = el.querySelector("[data-count]");
  const search = el.querySelector("[data-search]");

  async function load() {
    const q = search.value.trim();
    const { items, total } = await api.customers({ q, limit: 500 });
    if (!isCurrent()) return;
    countEl.textContent = `${total} customer${total === 1 ? "" : "s"}`;
    if (!items.length) {
      listEl.innerHTML = q
        ? emptyState({ icon: icons.search, title: "No customers found", text: `Nothing matches “${q}”.` })
        : emptyState({
            icon: icons.users, title: "No customers yet", text: "Add your first customer to start invoicing.",
            actionHtml: `<button class="btn btn-primary" data-new>${icons.plus}Add Customer</button>`,
          });
      return;
    }
    listEl.innerHTML = `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Customer</th><th class="hide-sm">Contact</th><th>GSTIN</th><th class="hide-sm">State</th><th class="num">Invoices</th><th class="num hide-sm">Billed</th><th class="actions"></th></tr></thead>
        <tbody>${items.map((c) => `
          <tr class="clickable" data-id="${c.id}">
            <td><div class="strong">${esc(c.company_name || c.name)}</div>${c.company_name ? `<div class="sub">${esc(c.name)}</div>` : ""}</td>
            <td class="hide-sm"><div>${esc(c.phone || "—")}</div><div class="sub">${esc(c.email)}</div></td>
            <td class="mono">${esc(c.gstin || "—")}</td>
            <td class="hide-sm">${esc(c.state || "—")}</td>
            <td class="num">${c.invoice_count}</td>
            <td class="num hide-sm">${money(c.total_billed)}</td>
            <td class="actions">
              <button class="icon-btn" data-edit="${c.id}" title="Edit" aria-label="Edit">${icons.edit}</button>
              <button class="icon-btn danger" data-delete="${c.id}" title="Delete" aria-label="Delete">${icons.trash}</button>
            </td>
          </tr>`).join("")}
        </tbody></table></div>`;
    listEl._items = items;
  }

  const find = (id) => listEl._items.find((c) => String(c.id) === String(id));

  el.addEventListener("click", async (event) => {
    if (event.target.closest("[data-new]")) {
      if (await openCustomerForm()) load();
      return;
    }
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      if (await openCustomerForm(find(edit.dataset.edit))) load();
      return;
    }
    const del = event.target.closest("[data-delete]");
    if (del) {
      const customer = find(del.dataset.delete);
      const ok = await confirmDialog({
        title: "Delete customer?",
        message: `“${customer.company_name || customer.name}” will be permanently deleted.`,
        confirmText: "Delete", danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteCustomer(customer.id);
        toast("Customer deleted");
        load();
      } catch (error) { toastError(error); }
      return;
    }
    const row = event.target.closest("tr[data-id]");
    if (row) showCustomer(find(row.dataset.id), load);
  });

  search.addEventListener("input", debounce(load, 250));
  await load();
}

async function showCustomer(customer, reload) {
  const { el, close } = openModal({
    title: customer.company_name || customer.name,
    size: "lg",
    body: `
      <div class="form-grid">
        <div class="field"><label>Contact</label><div>${esc(customer.name)}</div><div class="sub">${esc(customer.phone)} ${customer.email ? "· " + esc(customer.email) : ""}</div></div>
        <div class="field"><label>GSTIN</label><div class="mono">${esc(customer.gstin || "Unregistered")}</div><div class="sub">${esc(customer.state || "State not set")}</div></div>
        <div class="field"><label>Billing address</label><div style="white-space:pre-line">${esc(customer.billing_address || "—")}</div></div>
        <div class="field"><label>Shipping address</label><div style="white-space:pre-line">${esc(customer.shipping_address || "—")}</div></div>
        ${customer.notes ? `<div class="field span-2"><label>Notes</label><div style="white-space:pre-line">${esc(customer.notes)}</div></div>` : ""}
      </div>
      <div class="card" style="margin-bottom:18px"><div class="card-header"><h2>Invoices</h2><span class="sub">${money(customer.total_billed)} billed</span></div><div data-invoices><div class="loading"><span class="spinner"></span></div></div></div>`,
    footer: `<button class="btn" data-edit-c>${icons.edit}Edit</button>
             <a class="btn btn-primary" href="#/invoices/new?customer=${customer.id}">${icons.plus}New Invoice</a>`,
  });
  el.querySelector("[data-edit-c]").addEventListener("click", async () => {
    close();
    if (await openCustomerForm(customer)) reload();
  });
  try {
    const { items } = await api.invoices({ customer_id: customer.id, limit: 20 });
    el.querySelector("[data-invoices]").innerHTML = items.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>Invoice</th><th>Date</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
          ${items.map((i) => `<tr class="clickable" onclick="location.hash='#/invoices/${i.id}'"><td class="strong">${esc(i.invoice_number)}</td><td>${fmtDate(i.invoice_date)}</td><td class="num">${money(i.grand_total)}</td><td>${statusPill(i.status)}</td></tr>`).join("")}
        </tbody></table></div>`
      : `<div class="empty" style="padding:24px">No invoices for this customer yet.</div>`;
  } catch (error) { toastError(error); }
}
