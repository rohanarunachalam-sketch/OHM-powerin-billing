// Material management: stock list with price details, stock in / out and history. Not connected to invoices.
import { api } from "../api.js";
import { getMeta } from "../store.js";
import { checkRequired, confirmDialog, emptyState, fillForm, formValues, openModal, searchBox, setFieldError, skeletonTable, toast, toastError, withBusy } from "../ui.js";
import { debounce, esc, fmtDate, icons, money, trimNumber } from "../utils.js";

const qty = (value) => trimNumber(String(value ?? "0"));
const QTY_PATTERN = /^\d+(\.\d{1,3})?$/;
const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/;
const KIND_LABELS = { in: "Stock in", out: "Stock out", set: "Stock count" };

export async function render({ el, setTitle, isCurrent }) {
  setTitle("Materials");
  el.innerHTML = `
    <div class="page-head">
      <div><h2>Material Management</h2><p>Your material stock with purchase and selling prices. Separate from products and invoices.</p></div>
      <div class="page-actions"><button class="btn btn-primary" data-new>${icons.plus}Add Material</button></div>
    </div>
    <div class="stats" data-stats></div>
    <div class="card">
      <div class="toolbar">${searchBox("Search by name, code, category, supplier or location")}
        <select data-category aria-label="Filter by category"><option value="">All categories</option></select>
        <label class="check" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-low> Low stock only</label>
        <span class="result-count" data-count></span></div>
      <div data-list>${skeletonTable(8)}</div>
    </div>`;

  const listEl = el.querySelector("[data-list]");
  const search = el.querySelector("[data-search]");
  const categorySelect = el.querySelector("[data-category]");
  const lowOnly = el.querySelector("[data-low]");
  let items = [];
  let categories = [];

  const stat = (cls, label, iconName, value, meta) => `
    <div class="card stat ${cls}">
      <div class="stat-label">${label}<span class="stat-icon" aria-hidden="true">${icons[iconName]}</span></div>
      <div class="stat-value" title="${esc(value)}">${value}</div>
      <div class="stat-meta">${meta}</div>
    </div>`;

  async function load() {
    const page = await api.materials({ q: search.value.trim(), category: categorySelect.value, low_stock: lowOnly.checked || "" });
    if (!isCurrent()) return;
    items = page.items;
    categories = page.categories;
    const s = page.summary;
    el.querySelector("[data-stats]").innerHTML =
      stat("", "Materials", "box", String(s.count), "items in the list")
      + stat("paid", "Stock value (cost)", "rupee", money(s.value_at_cost), "quantity × purchase price")
      + stat("", "Stock value (selling)", "trendUp", money(s.value_at_selling), "quantity × selling price")
      + stat(s.low_stock ? "overdue" : "", "Low stock", "alert", String(s.low_stock), `<b>${s.out_of_stock}</b> out of stock`);
    const chosen = categorySelect.value;
    categorySelect.innerHTML = `<option value="">All categories</option>${categories.map((c) => `<option value="${esc(c)}"${c === chosen ? " selected" : ""}>${esc(c)}</option>`).join("")}`;
    el.querySelector("[data-count]").textContent = `${page.total} material${page.total === 1 ? "" : "s"}`;

    if (!items.length) {
      const filtered = search.value.trim() || categorySelect.value || lowOnly.checked;
      listEl.innerHTML = filtered
        ? emptyState({ icon: icons.search, title: "No materials found", text: "Nothing matches the current search or filters." })
        : emptyState({
            icon: icons.box, title: "No materials yet",
            text: "Add the materials you keep in stock to track quantities and prices.",
            actionHtml: `<button class="btn btn-primary" data-new>${icons.plus}Add Material</button>`,
          });
      return;
    }
    listEl.innerHTML = `
      <div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">Material</th><th scope="col" class="hide-sm">Category</th><th scope="col" class="hide-sm">Location</th><th scope="col" class="num">Stock</th><th scope="col" class="num">Purchase price</th><th scope="col" class="num">Selling price</th><th scope="col" class="num hide-sm">Stock value</th><th scope="col" class="actions"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${items.map((m) => `
          <tr>
            <td><div class="strong">${esc(m.name)}</div><div class="sub">${[m.code && `<span class="mono">${esc(m.code)}</span>`, m.supplier && esc(m.supplier)].filter(Boolean).join(" · ")}</div></td>
            <td class="hide-sm">${esc(m.category || "—")}</td>
            <td class="hide-sm">${esc(m.location || "—")}</td>
            <td class="num"><div class="strong">${qty(m.quantity)} ${esc(m.unit)}</div>${Number(m.quantity) <= 0 ? '<span class="pill pill-overdue">Out of stock</span>' : m.is_low ? `<span class="pill pill-pending">Low (min ${qty(m.min_stock)})</span>` : ""}</td>
            <td class="num">${money(m.purchase_price)}</td>
            <td class="num">${money(m.selling_price)}</td>
            <td class="num hide-sm">${money(m.stock_value)}</td>
            <td class="actions" style="white-space:nowrap">
              <button class="btn btn-sm" data-stock="${m.id}" data-kind="in" title="Add stock">+ In</button>
              <button class="btn btn-sm" data-stock="${m.id}" data-kind="out" title="Take stock out">− Out</button>
              <button class="icon-btn" data-history="${m.id}" title="Stock history" aria-label="Stock history of ${esc(m.name)}">${icons.clock}</button>
              <button class="icon-btn" data-edit="${m.id}" title="Edit" aria-label="Edit ${esc(m.name)}">${icons.edit}</button>
              <button class="icon-btn danger" data-delete="${m.id}" title="Delete" aria-label="Delete ${esc(m.name)}">${icons.trash}</button>
            </td>
          </tr>`).join("")}
        </tbody></table></div>`;
  }

  const find = (id) => items.find((m) => String(m.id) === String(id));

  el.addEventListener("click", async (event) => {
    if (event.target.closest("[data-new]")) {
      if (await openMaterialForm(null, categories)) load();
      return;
    }
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      if (await openMaterialForm(find(edit.dataset.edit), categories)) load();
      return;
    }
    const stock = event.target.closest("[data-stock]");
    if (stock) {
      if (await openStockForm(find(stock.dataset.stock), stock.dataset.kind)) load();
      return;
    }
    const history = event.target.closest("[data-history]");
    if (history) {
      const changed = await openHistory(find(history.dataset.history));
      if (changed) load();
      return;
    }
    const del = event.target.closest("[data-delete]");
    if (del) {
      const material = find(del.dataset.delete);
      const ok = await confirmDialog({
        title: "Delete material?",
        message: `“${material.name}” and its stock history will be removed. Invoices are not affected.`,
        confirmText: "Delete", danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteMaterial(material.id);
        toast("Material deleted", "success", `${material.name} was removed.`);
        load();
      } catch (error) { toastError(error); }
    }
  });

  search.addEventListener("input", debounce(() => load(), 250));
  categorySelect.addEventListener("change", () => load());
  lowOnly.addEventListener("change", () => load());
  await load();
}

function checkNumber(form, name, pattern, message) {
  const value = form.elements[name].value.trim();
  if (value && !pattern.test(value)) {
    setFieldError(form, name, message);
    return false;
  }
  return true;
}

async function openMaterialForm(material, categories) {
  const { units } = await getMeta();
  return new Promise((resolve) => {
    let saved = null;
    const { el, close } = openModal({
      title: material ? "Edit material" : "New material",
      onClose: () => resolve(saved),
      body: `
        <form id="material-form" novalidate>
          <div class="form-grid">
            <div class="field span-2"><label class="req" for="m-name">Material name</label><input id="m-name" name="name" maxlength="200" placeholder="e.g. Fuel filter"></div>
            <div class="field"><label for="m-code">Code / Part No</label><input id="m-code" name="code" maxlength="64"></div>
            <div class="field"><label for="m-cat">Category</label><input id="m-cat" name="category" maxlength="100" list="m-cat-list" placeholder="e.g. Filters">
              <datalist id="m-cat-list">${categories.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></div>
            <div class="field"><label for="m-unit">Unit</label><input id="m-unit" name="unit" maxlength="20" list="m-unit-list" value="Nos">
              <datalist id="m-unit-list">${units.map((u) => `<option value="${esc(u)}">`).join("")}</datalist></div>
            ${material
              ? `<div class="field"><label>Current stock</label><div class="field-hint" style="margin-top:8px"><b>${qty(material.quantity)} ${esc(material.unit)}</b>, change it with Stock In / Out.</div></div>`
              : `<div class="field"><label for="m-open">Opening stock</label><input id="m-open" name="opening_stock" inputmode="decimal" placeholder="0"></div>`}
            <div class="field"><label for="m-buy">Purchase price (₹)</label><input id="m-buy" name="purchase_price" inputmode="decimal" placeholder="0.00"></div>
            <div class="field"><label for="m-sell">Selling price (₹)</label><input id="m-sell" name="selling_price" inputmode="decimal" placeholder="0.00"></div>
            <div class="field"><label for="m-min">Minimum stock</label><input id="m-min" name="min_stock" inputmode="decimal" placeholder="0"><div class="field-hint">Shows a low-stock warning at or below this. 0 turns it off.</div></div>
            <div class="field"><label for="m-loc">Location</label><input id="m-loc" name="location" maxlength="100" placeholder="e.g. Rack A2"></div>
            <div class="field span-2"><label for="m-sup">Supplier</label><input id="m-sup" name="supplier" maxlength="200"></div>
            <div class="field span-2"><label for="m-notes">Notes</label><textarea id="m-notes" name="notes" maxlength="2000" rows="2"></textarea></div>
          </div>
        </form>`,
      footer: `<button type="button" class="btn" data-close>Cancel</button>
               <button type="submit" form="material-form" class="btn btn-primary">${material ? "Save changes" : "Add material"}</button>`,
    });

    const form = el.querySelector("#material-form");
    if (material) fillForm(form, { ...material, min_stock: qty(material.min_stock), purchase_price: material.purchase_price, selling_price: material.selling_price });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!checkRequired(form, { name: "Material name" })) return;
      const ok = [
        checkNumber(form, "purchase_price", PRICE_PATTERN, "Enter a valid amount with up to 2 decimals."),
        checkNumber(form, "selling_price", PRICE_PATTERN, "Enter a valid amount with up to 2 decimals."),
        checkNumber(form, "min_stock", QTY_PATTERN, "Enter a quantity with up to 3 decimals."),
        material ? true : checkNumber(form, "opening_stock", QTY_PATTERN, "Enter a quantity with up to 3 decimals."),
      ].every(Boolean);
      if (!ok) return;
      const data = formValues(form);
      for (const key of ["purchase_price", "selling_price", "min_stock", "opening_stock"]) {
        if (key in data) data[key] = data[key] || "0";
      }
      const button = el.querySelector('button[type="submit"]');
      try {
        await withBusy(button, async () => {
          saved = material ? await api.updateMaterial(material.id, data) : await api.createMaterial(data);
        });
        toast(material ? "Material updated" : "Material added", "success", `${saved.name} has been saved.`);
        close();
      } catch (error) { toastError(error); }
    });
  });
}

function openStockForm(material, kind) {
  return new Promise((resolve) => {
    let saved = null;
    const today = new Date().toISOString().slice(0, 10);
    const { el, close } = openModal({
      title: `${material.name}`,
      size: "sm",
      onClose: () => resolve(saved),
      body: `
        <form id="stock-form" novalidate>
          <p class="modal-text">In stock now: <b>${qty(material.quantity)} ${esc(material.unit)}</b></p>
          <div class="form-grid">
            <div class="field span-2"><label for="st-kind">Type</label>
              <select id="st-kind" name="kind">
                <option value="in">Stock in (received / purchased)</option>
                <option value="out">Stock out (used / sold)</option>
                <option value="set">Stock count (set the exact quantity)</option>
              </select></div>
            <div class="field"><label class="req" for="st-qty" data-qty-label>Quantity</label><input id="st-qty" name="quantity" inputmode="decimal" placeholder="0"></div>
            <div class="field"><label for="st-date">Date</label><input id="st-date" name="movement_date" type="date" value="${today}"></div>
            <div class="field span-2" data-price-field><label for="st-price">Purchase price per ${esc(material.unit)} (₹)</label><input id="st-price" name="unit_price" inputmode="decimal" placeholder="${esc(material.purchase_price)}"><div class="field-hint">Optional. Updates the material's purchase price.</div></div>
            <div class="field span-2"><label for="st-note">Note</label><input id="st-note" name="note" maxlength="300" placeholder="e.g. Bill no., job, reason"></div>
          </div>
        </form>`,
      footer: `<button type="button" class="btn" data-close>Cancel</button>
               <button type="submit" form="stock-form" class="btn btn-primary">Save</button>`,
    });
    const form = el.querySelector("#stock-form");
    form.kind.value = kind;
    const sync = () => {
      el.querySelector("[data-price-field]").hidden = form.kind.value !== "in";
      el.querySelector("[data-qty-label]").textContent = form.kind.value === "set" ? "Counted quantity" : "Quantity";
    };
    form.kind.addEventListener("change", sync);
    sync();
    form.quantity.focus();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!checkRequired(form, { quantity: "Quantity" })) return;
      if (!checkNumber(form, "quantity", QTY_PATTERN, "Enter a quantity with up to 3 decimals.")) return;
      if (form.kind.value === "in" && !checkNumber(form, "unit_price", PRICE_PATTERN, "Enter a valid amount with up to 2 decimals.")) return;
      const data = formValues(form);
      if (data.kind !== "in" || !data.unit_price) delete data.unit_price;
      if (!data.movement_date) delete data.movement_date;
      try {
        await withBusy(el.querySelector('button[type="submit"]'), async () => { saved = await api.moveStock(material.id, data); });
        toast("Stock updated", "success", `${saved.name}: ${qty(saved.quantity)} ${saved.unit} in stock.`);
        close();
      } catch (error) { toastError(error); }
    });
  });
}

async function openHistory(material) {
  let moves = [];
  try { moves = await api.materialMovements(material.id); } catch (error) { toastError(error); return false; }
  return new Promise((resolve) => {
    openModal({
      title: `Stock history · ${material.name}`,
      onClose: () => resolve(false),
      body: moves.length
        ? `<div class="table-wrap"><table class="table">
            <thead><tr><th scope="col">Date</th><th scope="col">Type</th><th scope="col" class="num">Change</th><th scope="col" class="num">Balance</th><th scope="col" class="num">Price</th><th scope="col">Note</th></tr></thead>
            <tbody>${moves.map((mv) => `<tr>
              <td>${esc(fmtDate(mv.movement_date))}</td>
              <td>${KIND_LABELS[mv.kind] || esc(mv.kind)}</td>
              <td class="num" style="color:${Number(mv.quantity) < 0 ? "var(--danger)" : "var(--success)"}">${Number(mv.quantity) > 0 ? "+" : ""}${qty(mv.quantity)}</td>
              <td class="num">${qty(mv.balance)} ${esc(material.unit)}</td>
              <td class="num">${mv.unit_price ? money(mv.unit_price) : "—"}</td>
              <td>${esc(mv.note || "")}</td></tr>`).join("")}
            </tbody></table></div>`
        : '<p class="modal-text">No stock movements yet.</p>',
      footer: '<button type="button" class="btn btn-primary" data-close>Close</button>',
    });
  });
}
