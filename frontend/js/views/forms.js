// Customer and product forms, opened as modals from several screens.
import { api } from "../api.js";
import { getMeta, stateOptions } from "../store.js";
import { checkRequired, fillForm, formValues, openModal, setFieldError, toast, withBusy } from "../ui.js";
import { esc, GSTIN_PATTERN, trimNumber } from "../utils.js";

/** Show backend validation errors next to the matching field when possible. */
function showServerError(form, error, fieldLabels) {
  const message = error.message || "";
  for (const [name, label] of Object.entries(fieldLabels)) {
    if (message.toLowerCase().startsWith(label.toLowerCase() + ":")) {
      setFieldError(form, name, message.slice(label.length + 1).trim());
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

const CUSTOMER_LABELS = {
  name: "Name", company_name: "Company name", phone: "Phone", email: "Email", gstin: "GSTIN",
  state_code: "State", billing_address: "Billing address", shipping_address: "Shipping address",
};

/** Opens the add/edit customer modal. Resolves with the saved customer, or null if cancelled. */
export async function openCustomerForm(customer = null, { prefillName = "" } = {}) {
  const { states } = await getMeta();
  return new Promise((resolve) => {
    let saved = null;
    const { el, close } = openModal({
      title: customer ? "Edit customer" : "New customer",
      size: "lg",
      onClose: () => resolve(saved),
      body: `
        <form id="customer-form" novalidate>
          <div class="form-grid">
            <div class="field"><label class="req" for="c-name">Customer name</label><input id="c-name" name="name" maxlength="200"></div>
            <div class="field"><label for="c-company">Company name</label><input id="c-company" name="company_name" maxlength="200"></div>
            <div class="field"><label for="c-phone">Phone</label><input id="c-phone" name="phone" type="tel" maxlength="20" placeholder="+91 98765 43210"></div>
            <div class="field"><label for="c-email">Email</label><input id="c-email" name="email" type="email" maxlength="200"></div>
            <div class="field"><label for="c-gstin">GSTIN</label><input id="c-gstin" name="gstin" maxlength="15" style="text-transform:uppercase" placeholder="Leave blank if unregistered"><div class="field-hint" data-gstin-hint></div></div>
            <div class="field"><label for="c-state">State (place of supply)</label><select id="c-state" name="state_code">${stateOptions(states)}</select><div class="field-hint">Decides CGST + SGST or IGST on invoices.</div></div>
            <div class="field"><label for="c-billing">Billing address</label><textarea id="c-billing" name="billing_address" maxlength="1000" rows="3"></textarea></div>
            <div class="field">
              <label for="c-shipping">Shipping address</label>
              <textarea id="c-shipping" name="shipping_address" maxlength="1000" rows="3"></textarea>
              <label class="checkbox field-hint" style="margin-top:6px"><input type="checkbox" data-same> Same as billing address</label>
            </div>
            <div class="field span-2"><label for="c-notes">Notes</label><textarea id="c-notes" name="notes" maxlength="2000" rows="2"></textarea></div>
          </div>
        </form>`,
      footer: `<button type="button" class="btn" data-close>Cancel</button>
               <button type="submit" form="customer-form" class="btn btn-primary">${customer ? "Save changes" : "Create customer"}</button>`,
    });

    const form = el.querySelector("#customer-form");
    if (customer) fillForm(form, customer);
    else if (prefillName) form.name.value = prefillName;

    const gstin = form.gstin;
    const hint = el.querySelector("[data-gstin-hint]");
    const checkGstin = () => {
      const value = gstin.value.trim().toUpperCase();
      hint.className = "field-hint";
      hint.textContent = "";
      if (!value) return;
      if (!GSTIN_PATTERN.test(value)) {
        hint.className = "field-hint warn";
        hint.textContent = "This doesn't look like a standard 15-character GSTIN.";
        return;
      }
      const code = value.slice(0, 2);
      if (!form.state_code.value && [...form.state_code.options].some((o) => o.value === code)) {
        form.state_code.value = code;
        hint.textContent = "State filled from GSTIN.";
      }
    };
    gstin.addEventListener("input", checkGstin);
    checkGstin();

    const same = el.querySelector("[data-same]");
    same.addEventListener("change", () => {
      if (same.checked) form.shipping_address.value = form.billing_address.value;
    });
    form.billing_address.addEventListener("input", () => {
      if (same.checked) form.shipping_address.value = form.billing_address.value;
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!checkRequired(form, { name: "Customer name" })) return;
      const data = formValues(form);
      data.gstin = data.gstin.toUpperCase();
      const button = el.querySelector('button[type="submit"]');
      try {
        await withBusy(button, async () => {
          saved = customer ? await api.updateCustomer(customer.id, data) : await api.createCustomer(data);
        });
        toast(customer ? "Customer updated" : `Customer “${saved.name}” created`);
        close();
      } catch (error) {
        if (!showServerError(form, error, CUSTOMER_LABELS)) toast(error.message, "error");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

const PRODUCT_LABELS = {
  name: "Name", sku: "Part No", hsn_sac: "HSN/SAC", unit: "Unit", price: "Price", gst_rate: "GST rate", description: "Description",
};

export async function openProductForm(product = null, { prefillName = "" } = {}) {
  const { gst_rates: rates, units } = await getMeta();
  return new Promise((resolve) => {
    let saved = null;
    const { el, close } = openModal({
      title: product ? "Edit product / service" : "New product / service",
      onClose: () => resolve(saved),
      body: `
        <form id="product-form" novalidate>
          <div class="form-grid">
            <div class="field span-2"><label class="req" for="p-name">Name</label><input id="p-name" name="name" maxlength="200" placeholder="e.g. Cement (50 kg bag)"></div>
            <div class="field"><label for="p-sku">Part No</label><input id="p-sku" name="sku" maxlength="64"></div>
            <div class="field"><label for="p-hsn">HSN / SAC code</label><input id="p-hsn" name="hsn_sac" maxlength="10" inputmode="numeric" placeholder="e.g. 2523"></div>
            <div class="field"><label class="req" for="p-price">Selling price (₹)</label><input id="p-price" name="price" inputmode="decimal" placeholder="0.00"></div>
            <div class="field"><label for="p-unit">Unit</label>
              <input id="p-unit" name="unit" maxlength="20" list="unit-list" value="Nos">
              <datalist id="unit-list">${units.map((u) => `<option value="${esc(u)}">`).join("")}</datalist>
            </div>
            <div class="field"><label class="req" for="p-gst">GST rate</label>
              <select id="p-gst" name="gst_rate">${rates.map((r) => `<option value="${r}"${r === "18" ? " selected" : ""}>${r}%</option>`).join("")}</select>
            </div>
            <div class="field span-2"><label for="p-desc">Description</label><textarea id="p-desc" name="description" maxlength="1000" rows="2" placeholder="Shown below the item name on invoices"></textarea></div>
          </div>
        </form>`,
      footer: `<button type="button" class="btn" data-close>Cancel</button>
               <button type="submit" form="product-form" class="btn btn-primary">${product ? "Save changes" : "Create product"}</button>`,
    });

    const form = el.querySelector("#product-form");
    if (product) fillForm(form, { ...product, price: product.price, gst_rate: trimNumber(product.gst_rate) });
    else if (prefillName) form.name.value = prefillName;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!checkRequired(form, { name: "Name", price: "Selling price" })) return;
      const data = formValues(form);
      if (!/^\d+(\.\d{1,2})?$/.test(data.price)) {
        setFieldError(form, "price", "Enter a valid amount with up to 2 decimals.");
        return;
      }
      const button = el.querySelector('button[type="submit"]');
      try {
        await withBusy(button, async () => {
          saved = product ? await api.updateProduct(product.id, data) : await api.createProduct(data);
        });
        toast(product ? "Product updated" : `“${saved.name}” added`);
        close();
      } catch (error) {
        if (!showServerError(form, error, PRODUCT_LABELS)) toast(error.message, "error");
      }
    });
  });
}
