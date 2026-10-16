import { api } from "../api.js";
import { confirmDialog, emptyState, searchBox, toast, toastError } from "../ui.js";
import { debounce, esc, icons, money, trimNumber } from "../utils.js";
import { openProductForm } from "./forms.js";

export async function render({ el, setTitle, isCurrent }) {
  setTitle("Products & Services", "Sales");
  el.innerHTML = `
    <div class="page-head">
      <div><p>Your catalogue of goods and services with HSN/SAC codes and GST rates.</p></div>
      <div class="page-actions"><input type="file" accept=".csv,.xlsx,text/csv" data-import-file hidden><button class="btn" data-import title="Columns: Part No, Description of Goods, HSN/SAC, Unit, Price, GST %">${icons.upload}Import Excel/CSV</button><button class="btn btn-primary" data-new>${icons.plus}New Item</button></div>
    </div>
    <div class="card">
      <div class="toolbar">${searchBox("Search by part no, name or HSN/SAC")}<span class="result-count" data-count></span></div>
      <div data-list><div class="loading"><span class="spinner"></span>Loading…</div></div>
    </div>`;

  const listEl = el.querySelector("[data-list]");
  const search = el.querySelector("[data-search]");
  let items = [];

  async function load() {
    const q = search.value.trim();
    const page = await api.products({ q, limit: 1000 });
    if (!isCurrent()) return;
    items = page.items;
    el.querySelector("[data-count]").textContent = `${page.total} item${page.total === 1 ? "" : "s"}`;
    if (!items.length) {
      listEl.innerHTML = q
        ? emptyState({ icon: icons.search, title: "No items found", text: `Nothing matches “${q}”.` })
        : emptyState({
            icon: icons.box, title: "No products or services yet",
            text: "Add the items you sell so you can pick them quickly on invoices.",
            actionHtml: `<button class="btn btn-primary" data-new>${icons.plus}Add Item</button>`,
          });
      return;
    }
    listEl.innerHTML = `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Name</th><th class="hide-sm">Part No</th><th>HSN/SAC</th><th class="hide-sm">Unit</th><th class="num">Price</th><th class="num">GST</th><th class="actions"></th></tr></thead>
        <tbody>${items.map((p) => `
          <tr>
            <td><div class="strong">${esc(p.name)}</div>${p.description ? `<div class="sub">${esc(p.description.length > 80 ? p.description.slice(0, 80) + "…" : p.description)}</div>` : ""}</td>
            <td class="hide-sm mono">${esc(p.sku || "—")}</td>
            <td class="mono">${esc(p.hsn_sac || "—")}</td>
            <td class="hide-sm">${esc(p.unit)}</td>
            <td class="num">${money(p.price)}</td>
            <td class="num">${trimNumber(p.gst_rate)}%</td>
            <td class="actions">
              <button class="icon-btn" data-edit="${p.id}" title="Edit" aria-label="Edit">${icons.edit}</button>
              <button class="icon-btn danger" data-delete="${p.id}" title="Delete" aria-label="Delete">${icons.trash}</button>
            </td>
          </tr>`).join("")}
        </tbody></table></div>`;
  }

  const find = (id) => items.find((p) => String(p.id) === String(id));

  const importFile = el.querySelector("[data-import-file]");
  importFile.addEventListener("change", async () => {
    const file = importFile.files[0];
    importFile.value = "";
    if (!file) return;
    try {
      const result = await api.importProducts(file);
      toast(`Imported: ${result.created} added, ${result.updated} updated${result.error_count ? `, ${result.error_count} skipped` : ""}`, result.error_count ? "error" : "success");
      if (result.error_count) window.alert([`${result.error_count} row(s) were skipped:`, "", ...result.errors.slice(0, 15)].join("\n"));
      load();
    } catch (error) { toastError(error); }
  });

  el.addEventListener("click", async (event) => {
    if (event.target.closest("[data-import]")) { importFile.click(); return; }
    if (event.target.closest("[data-new]")) {
      if (await openProductForm()) load();
      return;
    }
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      if (await openProductForm(find(edit.dataset.edit))) load();
      return;
    }
    const del = event.target.closest("[data-delete]");
    if (del) {
      const product = find(del.dataset.delete);
      const ok = await confirmDialog({
        title: "Delete item?",
        message: `“${product.name}” will be removed from your catalogue. Existing invoices are not affected.`,
        confirmText: "Delete", danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteProduct(product.id);
        toast("Item deleted");
        load();
      } catch (error) { toastError(error); }
    }
  });

  search.addEventListener("input", debounce(load, 250));
  await load();
}
