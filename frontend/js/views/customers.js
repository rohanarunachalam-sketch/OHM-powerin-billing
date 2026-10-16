import { api } from "../api.js";
import { confirmDialog, emptyState, searchBox, skeletonStats, skeletonTable, toast, toastError } from "../ui.js";
import { debounce, esc, icons, money } from "../utils.js";
import { openCustomerForm } from "./forms.js";
import { bindInvoiceList, invoiceTable } from "./invoices.js";

export async function render({ el, params, setTitle, query, isCurrent, navigate }) {
  if (params.id) return renderDetail({ el, id: Number(params.id), setTitle, isCurrent, navigate });
  setTitle("Customers");
  el.innerHTML = `
    <div class="page-head">
      <div><h2>Customers</h2><p>Manage the people and businesses you bill.</p></div>
      <div class="page-actions"><button class="btn btn-primary" data-new>${icons.plus}Add Customer</button></div>
    </div>
    <div class="card">
      <div class="toolbar">${searchBox("Search by name, company, GSTIN, phone or email", query.q || "")}<span class="result-count" data-count></span></div>
      <div data-list>${skeletonTable(6)}</div>
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
        <thead><tr><th scope="col">Customer</th><th scope="col" class="hide-sm">Contact</th><th scope="col">GSTIN</th><th scope="col" class="hide-sm">State</th><th scope="col" class="num">Invoices</th><th scope="col" class="num hide-sm">Billed</th><th scope="col" class="num">Outstanding</th><th scope="col" class="actions"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${items.map((c) => `
          <tr class="clickable" data-id="${c.id}">
            <td><a class="strong" style="color:inherit" href="#/customers/${c.id}">${esc(c.company_name || c.name)}</a>${c.company_name ? `<div class="sub">${esc(c.name)}</div>` : ""}</td>
            <td class="hide-sm"><div>${esc(c.phone || "—")}</div><div class="sub">${esc(c.email)}</div></td>
            <td class="mono">${esc(c.gstin || "—")}</td>
            <td class="hide-sm">${esc(c.state || "—")}</td>
            <td class="num">${c.invoice_count}</td>
            <td class="num hide-sm">${money(c.total_billed)}</td>
            <td class="num ${Number(c.outstanding) > 0 ? "balance-pos" : "balance-zero"}">${money(c.outstanding)}</td>
            <td class="actions">
              <button class="icon-btn" data-edit="${c.id}" title="Edit" aria-label="Edit ${esc(c.company_name || c.name)}">${icons.edit}</button>
              <button class="icon-btn danger" data-delete="${c.id}" title="Delete" aria-label="Delete ${esc(c.company_name || c.name)}">${icons.trash}</button>
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
        toast("Customer deleted", "success", `${customer.company_name || customer.name} was removed.`);
        load();
      } catch (error) { toastError(error); }
      return;
    }
    if (event.target.closest("a, button")) return;
    const row = event.target.closest("tr[data-id]");
    if (row) location.hash = `#/customers/${row.dataset.id}`;
  });

  search.addEventListener("input", debounce(load, 250));
  await load();
}

async function renderDetail({ el, id, setTitle, isCurrent, navigate }) {
  setTitle("Customer", `<a href="#/customers">Customers</a>`);
  el.innerHTML = `${skeletonStats(4)}<div class="card">${skeletonTable(4)}</div>`;
  let customer;
  try {
    customer = await api.customer(id);
  } catch (error) {
    if (!isCurrent()) return;
    toastError(error);
    navigate("#/customers");
    return;
  }
  if (!isCurrent()) return;
  const name = customer.company_name || customer.name;
  setTitle(name, `<a href="#/customers">Customers</a>`);

  const stat = (cls, label, iconName, value, meta) => `
    <div class="card stat ${cls}"><div class="stat-label">${label}<span class="stat-icon" aria-hidden="true">${icons[iconName]}</span></div>
    <div class="stat-value">${value}</div><div class="stat-meta">${meta}</div></div>`;
  const owes = Number(customer.outstanding) > 0;

  el.innerHTML = `
    <a class="back-link" href="#/customers">${icons.back}All customers</a>
    <div class="cust-head">
      <div>
        <h2 style="font-size:var(--fs-page)">${esc(name)}</h2>
        ${customer.company_name ? `<div class="sub" style="font-size:var(--fs-small)">Contact: ${esc(customer.name)}</div>` : ""}
        <div class="cust-meta">
          <span>${icons.receipt}GSTIN: <b class="mono">${esc(customer.gstin || "Unregistered")}</b></span>
          ${customer.phone ? `<span>${icons.users}${esc(customer.phone)}</span>` : ""}
          ${customer.email ? `<span>${icons.doc}${esc(customer.email)}</span>` : ""}
          ${customer.state ? `<span>${icons.building}${esc(customer.state)}</span>` : ""}
        </div>
        ${customer.billing_address ? `<div class="cust-meta" style="white-space:pre-line"><span>${icons.building}${esc(customer.billing_address)}</span></div>` : ""}
      </div>
      <div class="page-actions">
        <button class="btn" data-edit>${icons.edit}Edit</button>
        <a class="btn btn-primary" href="#/invoices/new?customer=${customer.id}">${icons.plus}Create Invoice</a>
      </div>
    </div>

    <div class="stats">
      ${stat("", "Total Billing", "receipt", money(customer.total_billed, { decimals: 0 }), "Issued invoices")}
      ${stat("paid", "Total Paid", "checkCircle", money(customer.total_paid, { decimals: 0 }), "Payments received")}
      ${stat(owes ? "overdue" : "pending", "Outstanding", "clock", money(customer.outstanding, { decimals: 0 }), owes ? "Still to be collected" : "Nothing owed")}
      ${stat("", "Invoices", "doc", String(customer.invoice_count), "Issued so far")}
    </div>

    ${customer.shipping_address || customer.notes ? `<div class="card" style="margin-bottom:20px"><div class="card-body form-grid">
      ${customer.shipping_address ? `<div class="field"><label>Shipping address</label><div style="white-space:pre-line">${esc(customer.shipping_address)}</div></div>` : ""}
      ${customer.notes ? `<div class="field"><label>Notes</label><div style="white-space:pre-line">${esc(customer.notes)}</div></div>` : ""}
    </div></div>` : ""}

    <div class="card">
      <div class="card-header"><div><h2>Invoice history</h2></div></div>
      <div data-invoices>${skeletonTable(3)}</div>
    </div>`;

  let invoices = [];
  const loadInvoices = async () => {
    try {
      invoices = (await api.invoices({ customer_id: customer.id, limit: 100 })).items;
      if (!isCurrent()) return;
      el.querySelector("[data-invoices]").innerHTML = invoices.length
        ? invoiceTable(invoices, { showBalance: true })
        : emptyState({
            icon: icons.doc, title: "No invoices yet", text: "Invoices you raise for this customer will be listed here.",
            actionHtml: `<a class="btn btn-primary" href="#/invoices/new?customer=${customer.id}">${icons.plus}Create Invoice</a>`,
          });
    } catch (error) { toastError(error); }
  };
  bindInvoiceList(el.querySelector("[data-invoices]"), { items: () => invoices, reload: () => renderDetail({ el, id, setTitle, isCurrent, navigate }) });
  el.querySelector("[data-edit]").addEventListener("click", async () => {
    if (await openCustomerForm(customer)) renderDetail({ el, id, setTitle, isCurrent, navigate });
  });
  await loadInvoices();
}
