// Create / edit invoice: customer, details, dynamic items, live totals, server preview and save.
import { api } from "../api.js";
import { getMeta, getSettings, stateName, stateOptions } from "../store.js";
import { autocomplete, toast, toastError, withBusy } from "../ui.js";
import {
  calcLine, calcTotals, debounce, esc, icons, moneyFromPaise, todayISO, trimNumber,
} from "../utils.js";
import { openCustomerForm, openProductForm } from "./forms.js";
import { fitDocument, renderInvoiceDocument } from "./invoice-doc.js";

const blankRow = () => ({
  product_id: null, part_no: "", name: "", description: "", hsn_sac: "", quantity: "1", unit: "Nos",
  rate: "", discount_type: "percent", discount_value: "", gst_rate: "18",
});

const rowFromProduct = (product, row = blankRow()) => ({
  ...row,
  product_id: product.id,
  part_no: product.sku || "",
  name: product.name,
  description: product.description || "",
  hsn_sac: product.hsn_sac || "",
  quantity: row.quantity || "1",
  unit: product.unit || "Nos",
  rate: product.price,
  gst_rate: trimNumber(product.gst_rate),
});

const isEmptyRow = (row) => !row.name.trim() && !String(row.rate).trim();

export async function render({ el, params, query, setTitle, navigate, setLeaveGuard, isCurrent }) {
  const editingId = params.id ? Number(params.id) : null;
  setTitle(editingId ? "Edit Invoice" : "Create Invoice", `<a href="#/invoices">Invoices</a>`);

  const [meta, settings] = await Promise.all([
    getMeta(), getSettings({ fresh: true }),
  ]);
  if (!isCurrent()) return;

  if (!settings.is_configured) {
    el.innerHTML = `<div class="card placeholder-page">
      <div class="empty-icon">${icons.info}</div>
      <h2>Set up your business first</h2>
      <p class="modal-text">Your business name and state are needed to issue GST invoices (they decide CGST/SGST vs IGST).</p>
      <a class="btn btn-primary" href="#/settings">Go to Settings</a></div>`;
    return;
  }

  const state = {
    customer: null,
    invoice_number: "",
    other_reference: "",
    contact_phone: "",
    esn: "",
    page_mode: "fit",
    invoice_date: todayISO(),
    place_of_supply: "",
    notes: settings.invoice_notes || "",
    terms: settings.invoice_terms || "",
    items: [blankRow()],
    status: "Pending",
  };
  let dirty = false;
  let saved = false;
  setLeaveGuard(() => dirty && !saved);

  // "Duplicate" opens a new invoice pre-filled from an existing one (new number, today's date).
  const duplicateId = !editingId && query.duplicate ? Number(query.duplicate) : null;
  if (editingId || duplicateId) {
    const inv = await api.invoice(editingId || duplicateId);
    if (!isCurrent()) return;
    if (editingId && ["Paid", "Partially Paid", "Cancelled"].includes(inv.status)) {
      toast("This invoice can't be edited", "error", "Paid, partially paid or cancelled invoices are locked. Duplicate it to start a new one.");
      navigate(`#/invoices/${editingId}`);
      return;
    }
    let customer = null;
    if (inv.customer_id) customer = await api.customer(inv.customer_id).catch(() => null);
    Object.assign(state, {
      customer,
      invoice_number: editingId ? inv.invoice_number : settings.next_invoice_number,
      other_reference: inv.other_reference || "",
      contact_phone: inv.contact_phone || "",
      esn: inv.esn || "",
      page_mode: inv.page_mode || "fit",
      invoice_date: editingId ? inv.invoice_date : todayISO(),
      place_of_supply: inv.place_of_supply,
      notes: inv.notes,
      terms: inv.terms,
      status: editingId && inv.status === "Draft" ? "Draft" : "Pending",
      items: inv.items.map((item) => ({
        product_id: item.product_id, part_no: item.part_no || "", name: item.name, description: item.description, hsn_sac: item.hsn_sac,
        quantity: trimNumber(item.quantity), unit: item.unit, rate: item.rate,
        discount_type: item.discount_type,
        discount_value: Number(item.discount_value) ? trimNumber(item.discount_value) : "",
        gst_rate: trimNumber(item.gst_rate),
      })),
    });
  } else {
    state.invoice_number = settings.next_invoice_number;
    if (query.customer) {
      state.customer = await api.customer(query.customer).catch(() => null);
      state.place_of_supply = state.customer?.state_code || "";
    }
  }

  const businessState = settings.state_code;
  const placeOfSupply = () => state.place_of_supply || state.customer?.state_code || businessState;
  const isInterstate = () => placeOfSupply() !== businessState;

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  el.innerHTML = `
    <div class="page-head">
      <div><h2>${editingId ? "Edit Invoice" : duplicateId ? "Duplicate Invoice" : "Create Invoice"}</h2><p>${editingId ? "Update the details — totals are verified by the server when you save." : "Fill in the details on the left; the invoice preview updates as you type."}</p></div>
    </div>
    <div class="compose" data-editor>
      <div data-form-col>
      <div class="card">
        <div class="card-header"><div><h2>Invoice details</h2><p>Bill to an existing customer or add a new one.</p></div><span data-supply></span></div>
        <div class="card-body">
          <div class="details-grid">
            <div>
              <label class="req" for="customer-search">Customer</label>
              <div data-customer-picker><input id="customer-search" placeholder="Search customer by name, company or GSTIN"></div>
              <div data-customer-card style="margin-top:10px"></div>
              <button type="button" class="btn btn-ghost btn-sm" data-new-customer style="margin-top:8px;padding-left:4px">${icons.plus}Add new customer</button>
            </div>
            <div class="form-grid">
              <div class="field"><label class="req" for="inv-number">Invoice number</label><input id="inv-number" data-field="invoice_number" maxlength="40"><div class="field-hint">Generated automatically. Type your own and the next one continues from it.</div></div>
              <div class="field"><label class="req" for="inv-date">Invoice date</label><input id="inv-date" type="date" data-field="invoice_date"></div>
              <div class="field"><label for="inv-ref">Other reference</label><input id="inv-ref" data-field="other_reference" maxlength="100" placeholder="Optional"></div>
              <div class="field"><label for="inv-phone">Phone</label><input id="inv-phone" data-field="contact_phone" maxlength="100" placeholder="Optional"></div>
              <div class="field"><label for="inv-esn">ESN</label><input id="inv-esn" data-field="esn" maxlength="100" placeholder="Optional"></div>
              <div class="field"><label for="inv-pages">PDF pages</label>
                <select id="inv-pages" data-field="page_mode"><option value="fit">Fit on one page</option><option value="pages">Continue on more pages</option></select>
                <div class="field-hint">"Fit on one page" shrinks the invoice to one A4 sheet; very long invoices still continue.</div>
              </div>
              <div class="field span-2"><label for="inv-pos">Place of supply</label>
                <select id="inv-pos" data-field="place_of_supply">${stateOptions(meta.states, "", "Same as customer's state")}</select>
                <div class="field-hint" data-pos-hint></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div><h2>Items</h2><p>Type a part number or description to fill the row automatically, or enter a one-off item.</p></div></div>
        <div class="table-wrap">
          <table class="items-table">
            <thead><tr>
              <th>#</th><th class="col-part">Part No</th><th class="col-item">Description of Goods</th><th class="col-hsn">HSN/SAC</th><th class="col-qty num">Qty</th>
              <th class="col-unit">Unit</th><th class="col-rate num">Rate (₹)</th><th class="col-disc">Discount</th>
              <th class="col-gst">GST %</th><th class="col-amt num">Amount</th><th></th>
            </tr></thead>
            <tbody data-rows></tbody>
          </table>
        </div>
        <div class="items-footer">
          <button type="button" class="btn btn-sm" data-add-row title="Enter in an item row">${icons.plus}Add Item</button>
          <button type="button" class="btn btn-sm btn-ghost" data-new-product>${icons.box}Create new product</button>
        </div>
      </div>

      <div class="editor-grid" style="margin-top:20px">
        <div class="card">
          <div class="card-body">
            <div class="field"><label for="inv-notes">Customer notes</label><textarea id="inv-notes" data-field="notes" rows="3" maxlength="2000"></textarea></div>
            <div class="field" style="margin-bottom:0"><label for="inv-tc">Terms &amp; conditions</label><textarea id="inv-tc" data-field="terms" rows="4" maxlength="3000"></textarea></div>
          </div>
        </div>
        <div class="card" data-totals></div>
      </div>

      <div class="sticky-footer">
        <a class="btn btn-ghost" href="${editingId ? `#/invoices/${editingId}` : "#/invoices"}">Cancel</a>
        <span class="spacer"></span>
        <button type="button" class="btn" data-save-draft data-busy="Saving…">Save as Draft</button>
        <button type="button" class="btn" data-preview data-shortcut="print" title="Ctrl+P" data-busy="Calculating…">${icons.eye}Full preview</button>
        <button type="button" class="btn btn-primary btn-lg" data-save-main data-shortcut="save" title="Ctrl+S" data-busy="Generating PDF…">${icons.check}${editingId ? "Save changes" : "Save & Generate PDF"}</button>
      </div>
      </div>
      <aside class="compose-preview" aria-label="Invoice preview">
        <div class="card">
          <div class="card-header"><div><h2>Live preview</h2><p>As it will appear on the PDF</p></div><span class="live-state" data-live-state></span></div>
          <div class="live-frame" data-live data-fit-doc><div class="live-empty">Choose a customer and add an item to see the invoice here.</div></div>
        </div>
      </aside>
    </div>
    <div data-preview-pane hidden></div>`;

  const $ = (selector) => el.querySelector(selector);
  const rowsEl = $("[data-rows]");
  const fields = {};
  el.querySelectorAll("[data-field]").forEach((input) => { fields[input.dataset.field] = input; });

  // -------------------------------------------------------------------------
  // Header fields
  // -------------------------------------------------------------------------

  fields.invoice_number.value = state.invoice_number;
  for (const name of ["other_reference", "contact_phone", "esn", "page_mode"]) fields[name].value = state[name];
  fields.invoice_date.value = state.invoice_date;
  fields.notes.value = state.notes;
  fields.terms.value = state.terms;
  fields.place_of_supply.value = state.place_of_supply;

  const markDirty = () => { dirty = true; };

  // New invoices are dated today. If the form was left open past midnight and the user never touched the
  // date, it is refreshed to the current date when the invoice is saved or previewed.
  let dateTouched = Boolean(editingId);
  const useCurrentDate = () => {
    if (dateTouched) return;
    const today = todayISO();
    if (state.invoice_date !== today) {
      state.invoice_date = today;
      fields.invoice_date.value = today;
    }
  };
  fields.invoice_date.addEventListener("change", () => {
    dateTouched = true;
    state.invoice_date = fields.invoice_date.value;
    markDirty();
  });
  for (const name of ["invoice_number", "other_reference", "contact_phone", "esn", "notes", "terms"]) {
    fields[name].addEventListener("input", () => { state[name] = fields[name].value; markDirty(); });
  }
  fields.page_mode.addEventListener("change", () => { state.page_mode = fields.page_mode.value; markDirty(); });
  fields.place_of_supply.addEventListener("change", () => {
    state.place_of_supply = fields.place_of_supply.value;
    markDirty();
    refreshSupply();
    refreshTotals();
  });

  // -------------------------------------------------------------------------
  // Customer
  // -------------------------------------------------------------------------

  const customerInput = $("#customer-search");

  function renderCustomer() {
    const card = $("[data-customer-card]");
    const picker = $("[data-customer-picker]");
    const c = state.customer;
    picker.hidden = Boolean(c);
    $("[data-new-customer]").hidden = Boolean(c);
    if (!c) { card.innerHTML = ""; return; }
    const address = c.billing_address || "No billing address";
    card.innerHTML = `
      <div class="selected-customer">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
          <div class="name">${esc(c.company_name || c.name)}</div>
          <div><button type="button" class="btn btn-sm btn-ghost" data-edit-customer>Edit</button><button type="button" class="btn btn-sm btn-ghost" data-change-customer>Change</button></div>
        </div>
        ${c.company_name ? `<div>${esc(c.name)}</div>` : ""}
        <div class="meta">${esc(address)}</div>
        <div class="meta">GSTIN: ${esc(c.gstin || "Unregistered")} · ${esc(c.state || "State not set")}</div>
      </div>`;
    card.querySelector("[data-change-customer]").addEventListener("click", () => {
      state.customer = null;
      renderCustomer();
      refreshSupply();
      refreshTotals();
      customerInput.value = "";
      customerInput.focus();
    });
    card.querySelector("[data-edit-customer]").addEventListener("click", async () => {
      const updated = await openCustomerForm(state.customer);
      if (updated) selectCustomer(updated);
    });
  }

  function selectCustomer(customer) {
    state.customer = customer;
    // Place of supply follows the customer unless the user picked one explicitly.
    if (!fields.place_of_supply.value || fields.place_of_supply.dataset.auto === "1") {
      state.place_of_supply = customer.state_code || "";
      fields.place_of_supply.value = state.place_of_supply;
      fields.place_of_supply.dataset.auto = "1";
    }
    markDirty();
    renderCustomer();
    refreshSupply();
    refreshTotals();
  }

  fields.place_of_supply.addEventListener("change", () => { fields.place_of_supply.dataset.auto = "0"; });
  if (!editingId) fields.place_of_supply.dataset.auto = "1";

  autocomplete(customerInput, {
    source: async (q) => (await api.customers({ q, limit: 20 })).items,
    render: (c) => ({
      title: c.company_name || c.name,
      subtitle: [c.company_name ? c.name : "", c.gstin, c.state].filter(Boolean).join(" · "),
    }),
    onSelect: selectCustomer,
    action: {
      label: "+ Add new customer",
      onClick: async (q) => {
        const created = await openCustomerForm(null, { prefillName: q });
        if (created) selectCustomer(created);
      },
    },
  });
  $("[data-new-customer]").addEventListener("click", async () => {
    const created = await openCustomerForm(null, { prefillName: customerInput.value.trim() });
    if (created) selectCustomer(created);
  });

  function refreshSupply() {
    const inter = isInterstate();
    const pos = placeOfSupply();
    $("[data-supply]").innerHTML = state.customer || state.place_of_supply
      ? `<span class="supply-badge ${inter ? "inter" : ""}">${inter ? "Inter-state · IGST" : "Intra-state · CGST + SGST"}</span>`
      : "";
    $("[data-pos-hint]").textContent = `Business: ${stateName(meta.states, businessState)} → Supply to: ${stateName(meta.states, pos) || "—"}`;
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  const gstOptions = (selected) => meta.gst_rates
    .map((r) => `<option value="${r}"${r === selected ? " selected" : ""}>${r}%</option>`).join("");

  function rowHtml(row, index) {
    return `
      <tr data-row="${index}">
        <td class="row-index">${index + 1}</td>
        <td class="col-part"><div><input data-k="part_no" value="${esc(row.part_no)}" placeholder="Part No" maxlength="64"></div></td>
        <td class="col-item">
          <div><input data-k="name" value="${esc(row.name)}" placeholder="Search or type description" maxlength="200"></div>
          <textarea data-k="description" placeholder="Description (optional)" maxlength="1000">${esc(row.description)}</textarea>
        </td>
        <td><input data-k="hsn_sac" value="${esc(row.hsn_sac)}" inputmode="numeric" maxlength="10"></td>
        <td class="num"><input data-k="quantity" value="${esc(row.quantity)}" inputmode="decimal"></td>
        <td><input data-k="unit" value="${esc(row.unit)}" list="unit-options" maxlength="20"></td>
        <td class="num"><input data-k="rate" value="${esc(row.rate)}" inputmode="decimal" placeholder="0.00"></td>
        <td><div class="input-group">
          <input data-k="discount_value" value="${esc(row.discount_value)}" inputmode="decimal" placeholder="0" style="text-align:right">
          <select data-k="discount_type" aria-label="Discount type">
            <option value="percent"${row.discount_type === "percent" ? " selected" : ""}>%</option>
            <option value="amount"${row.discount_type === "amount" ? " selected" : ""}>₹</option>
          </select></div></td>
        <td><select data-k="gst_rate">${gstOptions(row.gst_rate)}</select></td>
        <td class="num line-amount" data-amount></td>
        <td><button type="button" class="icon-btn danger" data-remove title="Remove row" aria-label="Remove row" style="margin-top:1px">${icons.close}</button></td>
      </tr>`;
  }

  const searchProducts = async (q) => (await api.products({ q, limit: 30 })).items;

  function renderRows() {
    rowsEl.innerHTML = state.items.map(rowHtml).join("") +
      `<datalist id="unit-options">${meta.units.map((u) => `<option value="${esc(u)}">`).join("")}</datalist>`;
    rowsEl.querySelectorAll("tr[data-row]").forEach((tr) => {
      const index = Number(tr.dataset.row);
      const choose = (product) => {
        state.items[index] = rowFromProduct(product, state.items[index]);
        markDirty();
        renderRows();
        rowsEl.querySelector(`tr[data-row="${index}"] [data-k="quantity"]`)?.select();
      };
      const partInput = tr.querySelector('[data-k="part_no"]');
      autocomplete(partInput, {
        source: searchProducts,
        render: (p) => ({ title: `${p.sku} — ${p.name}`, subtitle: [p.hsn_sac && `HSN ${p.hsn_sac}`, `₹${p.price}`, `GST ${trimNumber(p.gst_rate)}%`].filter(Boolean).join(" · ") }),
        onSelect: choose,
      });
      // Typing a complete part number (without picking from the list) fills the row too, if it is a new row.
      partInput.addEventListener("change", async () => {
        const typed = partInput.value.trim().toLowerCase();
        if (!typed) return;
        const product = (await searchProducts(typed)).find((p) => p.sku && p.sku.toLowerCase() === typed);
        if (product && state.items[index].product_id !== product.id) choose(product);
      });
      autocomplete(tr.querySelector('[data-k="name"]'), {
        source: searchProducts,
        render: (p) => ({
          title: p.name,
          subtitle: [p.sku && `Part No ${p.sku}`, p.hsn_sac && `HSN ${p.hsn_sac}`, `₹${p.price}`, `GST ${trimNumber(p.gst_rate)}%`].filter(Boolean).join(" · "),
        }),
        onSelect: choose,
      });
    });
    refreshTotals();
  }

  rowsEl.addEventListener("input", (event) => {
    const tr = event.target.closest("tr[data-row]");
    const key = event.target.dataset.k;
    if (!tr || !key) return;
    const row = state.items[Number(tr.dataset.row)];
    row[key] = event.target.value;
    if (key === "name" || key === "part_no") row.product_id = null; // edited text: no longer the catalogue item
    event.target.classList.remove("invalid");
    markDirty();
    refreshTotals();
  });
  rowsEl.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove]");
    if (!remove) return;
    const index = Number(remove.closest("tr").dataset.row);
    state.items.splice(index, 1);
    if (!state.items.length) state.items.push(blankRow());
    markDirty();
    renderRows();
  });
  // Enter in an item row adds a new row (unless the suggestion list just used the Enter to pick an item).
  rowsEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.defaultPrevented || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
    if (!event.target.matches("input, select")) return;
    event.preventDefault();
    const index = Number(event.target.closest("tr")?.dataset.row);
    if (state.items[index] && isEmptyRow(state.items[index])) return;  // fill this row first
    $("[data-add-row]").click();
  });
  $("[data-add-row]").addEventListener("click", () => {
    state.items.push(blankRow());
    renderRows();
    rowsEl.querySelector(`tr[data-row="${state.items.length - 1}"] [data-k="name"]`).focus();
  });
  $("[data-new-product]").addEventListener("click", async () => {
    const product = await openProductForm();
    if (!product) return;
    const emptyIndex = state.items.findIndex(isEmptyRow);
    if (emptyIndex >= 0) state.items[emptyIndex] = rowFromProduct(product, state.items[emptyIndex]);
    else state.items.push(rowFromProduct(product));
    markDirty();
    renderRows();
  });

  // -------------------------------------------------------------------------
  // Live totals (display only — the server recalculates everything)
  // -------------------------------------------------------------------------

  const lineInput = (row) => ({
    quantity: row.quantity, rate: row.rate, discountType: row.discount_type,
    discountValue: row.discount_value, gstRate: row.gst_rate,
  });

  function refreshTotals() {
    const inter = isInterstate();
    rowsEl.querySelectorAll("tr[data-row]").forEach((tr) => {
      const row = state.items[Number(tr.dataset.row)];
      const result = isEmptyRow(row) ? null : calcLine(lineInput(row), inter);
      tr.querySelector("[data-amount]").textContent = result ? moneyFromPaise(result.taxable) : "—";
    });
    const rows = state.items.filter((row) => !isEmptyRow(row));
    const t = calcTotals(rows.map(lineInput), inter);
    const singleRate = new Set(rows.map((r) => r.gst_rate)).size === 1 ? Number(rows[0].gst_rate) : null;
    const label = (name, divisor) => (singleRate === null ? name : `${name} (${trimNumber(String(singleRate / divisor))}%)`);
    const line = (name, value, cls = "") => `<div class="totals-row ${cls}"><span>${name}</span><span>${value}</span></div>`;
    $("[data-totals]").innerHTML = `
      <div class="card-header"><h2>Summary</h2>${inter ? '<span class="supply-badge inter">IGST</span>' : '<span class="supply-badge">CGST + SGST</span>'}</div>
      <div class="totals">
        ${line("Subtotal", moneyFromPaise(t.subtotal))}
        ${line("Discount", t.discount ? "- " + moneyFromPaise(t.discount) : moneyFromPaise(0n), "muted")}
        ${line("Taxable amount", moneyFromPaise(t.taxable))}
        ${inter ? line(label("IGST", 1), moneyFromPaise(t.igst)) : line(label("CGST", 2), moneyFromPaise(t.cgst)) + line(label("SGST", 2), moneyFromPaise(t.sgst))}
        ${line("Round off", (t.roundOff > 0n ? "+ " : t.roundOff < 0n ? "- " : "") + moneyFromPaise(t.roundOff < 0n ? -t.roundOff : t.roundOff), "muted")}
        ${line("Grand Total", moneyFromPaise(t.grand), "grand")}
      </div>
      ${t.valid ? "" : '<div class="calc-note" style="color:var(--danger)">Some rows have invalid numbers and are excluded.</div>'}
      <div class="calc-note">Final amounts are calculated and verified by the server when you preview or save.</div>`;
    scheduleLive();
  }

  // -------------------------------------------------------------------------
  // Validation, payload, preview & save
  // -------------------------------------------------------------------------

  function validate() {
    el.querySelectorAll(".invalid").forEach((x) => x.classList.remove("invalid"));
    const problems = [];
    if (!state.customer) {
      problems.push("Select a customer.");
      customerInput.classList.add("invalid");
    }
    if (!state.invoice_date) {
      problems.push("Enter the invoice date.");
      fields.invoice_date.classList.add("invalid");
    }
    const rows = state.items.filter((row) => !isEmptyRow(row));
    if (!rows.length) problems.push("Add at least one item.");
    state.items.forEach((row, index) => {
      if (isEmptyRow(row)) return;
      const tr = rowsEl.querySelector(`tr[data-row="${index}"]`);
      let rowValid = true;
      const flag = (key, message) => {
        rowValid = false;
        tr.querySelector(`[data-k="${key}"]`).classList.add("invalid");
        problems.push(`Item ${index + 1}: ${message}`);
      };
      if (!row.name.trim()) flag("name", "name is required.");
      if (!/^\d+(\.\d{1,3})?$/.test(String(row.quantity).trim()) || Number(row.quantity) <= 0) flag("quantity", "enter a quantity greater than 0 (max 3 decimals).");
      if (!/^\d+(\.\d{1,2})?$/.test(String(row.rate).trim())) flag("rate", "enter a valid rate (max 2 decimals).");
      if (String(row.discount_value).trim() && !/^\d+(\.\d{1,2})?$/.test(String(row.discount_value).trim())) flag("discount_value", "enter a valid discount.");
      else if (row.discount_type === "percent" && Number(row.discount_value) > 100) flag("discount_value", "discount cannot exceed 100%.");
      if (rowValid && !calcLine(lineInput(row), false)) flag("discount_value", "discount cannot exceed the line amount.");
    });
    if (problems.length) {
      toast("Please check the highlighted fields", "error", problems[0]);
      el.querySelector(".invalid")?.focus();
    }
    return !problems.length;
  }

  function payload(status) {
    useCurrentDate();
    return {
      customer_id: state.customer.id,
      invoice_number: state.invoice_number.trim(),
      other_reference: state.other_reference.trim(),
      contact_phone: state.contact_phone.trim(),
      esn: state.esn.trim(),
      page_mode: state.page_mode,
      invoice_date: state.invoice_date,
      place_of_supply: state.place_of_supply,
      status,
      notes: state.notes,
      terms: state.terms,
      items: state.items.filter((row) => !isEmptyRow(row)).map((row) => ({
        product_id: row.product_id,
        part_no: row.part_no.trim(),
        name: row.name.trim(),
        description: row.description.trim(),
        hsn_sac: row.hsn_sac.trim(),
        quantity: String(row.quantity).trim(),
        unit: row.unit.trim(),
        rate: String(row.rate).trim(),
        discount_type: row.discount_type,
        discount_value: String(row.discount_value).trim() || "0",
        gst_rate: row.gst_rate,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Live preview: the server calculates and renders exactly what will be saved
  // -------------------------------------------------------------------------

  const liveEl = $("[data-live]");
  const liveState = $("[data-live-state]");
  let liveToken = 0;

  function readyForPreview() {
    if (!state.customer || !state.invoice_date) return false;
    const rows = state.items.filter((row) => !isEmptyRow(row));
    return rows.length > 0 && rows.every((row) =>
      row.name.trim() &&
      /^\d+(\.\d{1,3})?$/.test(String(row.quantity).trim()) && Number(row.quantity) > 0 &&
      /^\d+(\.\d{1,2})?$/.test(String(row.rate).trim()) &&
      (!String(row.discount_value).trim() || /^\d+(\.\d{1,2})?$/.test(String(row.discount_value).trim())) &&
      calcLine(lineInput(row), false));
  }

  const refreshLive = debounce(async () => {
    if (!readyForPreview()) {
      liveState.textContent = "";
      if (!liveEl.querySelector(".doc")) liveEl.innerHTML = '<div class="live-empty">Choose a customer and add an item to see the invoice here.</div>';
      return;
    }
    const token = ++liveToken;
    liveState.innerHTML = '<span class="spinner"></span>Updating';
    try {
      const inv = await api.previewInvoice(payload("Pending"), editingId);
      if (token !== liveToken || !isCurrent()) return;
      liveEl.innerHTML = renderInvoiceDocument(inv, api.docOptions(settings));
      fitDocument(liveEl);
      liveState.textContent = "";
    } catch {
      if (token === liveToken) liveState.textContent = "Preview unavailable";
    }
  }, 700);
  const scheduleLive = () => refreshLive();

  async function save(status, button) {
    if (!validate()) return;
    try {
      const invoice = await withBusy(button, () =>
        editingId ? api.updateInvoice(editingId, payload(status)) : api.createInvoice(payload(status)));
      saved = true;
      toast(status === "Draft" ? "Draft saved" : editingId ? "Invoice updated" : "Invoice created successfully", "success",
        status === "Draft" ? `${invoice.invoice_number} was saved as a draft.` : `Invoice ${invoice.invoice_number} has been saved and its PDF generated.`);
      navigate(`#/invoices/${invoice.id}${editingId ? "" : "?created=1"}`);
    } catch (error) {
      toastError(error);
      if (error.status === 409 && /already in use/.test(error.message) && !editingId) {
        const { invoice_number: next } = await api.nextInvoiceNumber();
        state.invoice_number = next;
        fields.invoice_number.value = next;
        fields.invoice_number.classList.add("invalid");
      }
    }
  }

  async function showPreview(button) {
    if (!validate()) return;
    let inv;
    try {
      inv = await withBusy(button, () => api.previewInvoice(payload("Pending"), editingId));
    } catch (error) {
      toastError(error);
      return;
    }
    const pane = $("[data-preview-pane]");
    $("[data-editor]").hidden = true;
    pane.hidden = false;
    setTitle(`Preview · ${inv.invoice_number}`, `<a href="#/invoices">Invoices</a>`);
    pane.innerHTML = `
      <div class="banner banner-info no-print">${icons.info}<div><b>Preview — not saved yet.</b> These totals were calculated by the server exactly as they will be stored. Review, then save to generate the A4 PDF.</div></div>
      <div class="doc-shell" data-fit-doc>${renderInvoiceDocument(inv, api.docOptions(settings))}</div>
      <div class="sticky-footer no-print">
        <button type="button" class="btn" data-back>${icons.back}Back to edit</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-save-draft-2 data-busy="Saving…">Save as Draft</button>
        <button type="button" class="btn btn-primary btn-lg" data-save data-shortcut="save" title="Ctrl+S" data-busy="Generating PDF…">${icons.download}Save &amp; Generate PDF</button>
      </div>`;
    window.scrollTo(0, 0);
    fitDocument(pane.querySelector(".doc-shell"));
    pane.querySelector("[data-back]").addEventListener("click", () => {
      pane.hidden = true;
      pane.innerHTML = "";
      $("[data-editor]").hidden = false;
      setTitle(editingId ? "Edit Invoice" : "New Invoice", `<a href="#/invoices">Invoices</a>`);
    });
    pane.querySelector("[data-save]").addEventListener("click", (e) => save("Pending", e.currentTarget));
    pane.querySelector("[data-save-draft-2]").addEventListener("click", (e) => save("Draft", e.currentTarget));
  }

  $("[data-preview]").addEventListener("click", (e) => showPreview(e.currentTarget));
  $("[data-save-draft]").addEventListener("click", (e) => save("Draft", e.currentTarget));
  $("[data-save-main]").addEventListener("click", (e) => save("Pending", e.currentTarget));

  renderCustomer();
  refreshSupply();
  renderRows();
  if (!state.customer) customerInput.focus();
}
