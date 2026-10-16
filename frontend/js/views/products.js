import { api } from "../api.js";
import { getMeta } from "../store.js";
import { confirmDialog, emptyState, openModal, searchBox, skeletonTable, toast, toastError } from "../ui.js";
import { debounce, esc, icons, money, trimNumber } from "../utils.js";
import { openProductForm } from "./forms.js";

const PAGE_SIZE = 100;

export async function render({ el, setTitle, isCurrent }) {
  const meta = await getMeta();
  setTitle("Products");
  el.innerHTML = `
    <div class="page-head">
      <div><h2>Products &amp; Services</h2><p>Your catalogue of goods and services with HSN/SAC codes and GST rates.</p></div>
      <div class="page-actions"><input type="file" accept=".csv,.xlsx,text/csv" data-import-file hidden><button class="btn" data-import title="Columns: Part No, Description of Goods, HSN/SAC, Unit, Price, GST %">${icons.upload}Import Excel/CSV</button><button class="btn btn-primary" data-new>${icons.plus}Add Item</button></div>
    </div>
    <div class="card">
      <div class="toolbar">${searchBox("Search by part no, name or HSN/SAC")}
        <select data-gst aria-label="Filter by GST rate"><option value="">All GST rates</option>${meta.gst_rates.map((r) => `<option value="${esc(r)}">${esc(trimNumber(r))}%</option>`).join("")}</select>
        <span class="result-count" data-count></span></div>
      <div data-list>${skeletonTable(7)}</div>
      <div class="items-footer" data-more hidden><button class="btn btn-sm" data-load-more>Load more</button></div>
    </div>`;

  const listEl = el.querySelector("[data-list]");
  const search = el.querySelector("[data-search]");
  let items = [];

  async function load(append = false) {
    const q = search.value.trim();
    const gst = el.querySelector("[data-gst]").value;
    const page = await api.products({ q, gst_rate: gst, limit: PAGE_SIZE, offset: append ? items.length : 0 });
    if (!isCurrent()) return;
    items = append ? items.concat(page.items) : page.items;
    el.querySelector("[data-more]").hidden = items.length >= page.total;
    el.querySelector("[data-count]").textContent = `${page.total} item${page.total === 1 ? "" : "s"}`;
    if (!items.length) {
      listEl.innerHTML = q || gst
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
        <thead><tr><th scope="col">Product</th><th scope="col" class="hide-sm">SKU / Part No</th><th scope="col">HSN/SAC</th><th scope="col" class="hide-sm">Unit</th><th scope="col" class="num">Price</th><th scope="col" class="num">GST rate</th><th scope="col" class="actions"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${items.map((p) => `
          <tr>
            <td><div class="strong">${esc(p.name)}</div>${p.description ? `<div class="sub">${esc(p.description.length > 80 ? p.description.slice(0, 80) + "…" : p.description)}</div>` : ""}</td>
            <td class="hide-sm mono">${esc(p.sku || "—")}</td>
            <td class="mono">${esc(p.hsn_sac || "—")}</td>
            <td class="hide-sm">${esc(p.unit)}</td>
            <td class="num">${money(p.price)}</td>
            <td class="num">${trimNumber(p.gst_rate)}%</td>
            <td class="actions">
              <button class="icon-btn" data-edit="${p.id}" title="Edit" aria-label="Edit ${esc(p.name)}">${icons.edit}</button>
              <button class="icon-btn danger" data-delete="${p.id}" title="Delete" aria-label="Delete ${esc(p.name)}">${icons.trash}</button>
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
        toast("Item deleted", "success", `${product.name} was removed from your catalogue.`);
        load();
      } catch (error) { toastError(error); }
    }
  });

  search.addEventListener("input", debounce(() => load(), 250));
  el.querySelector("[data-gst]").addEventListener("change", () => load());
  el.querySelector("[data-load-more]").addEventListener("click", () => load(true));
  await load();
}
