import { api } from "../api.js";
import { getMeta, getSettings, setSettings, stateOptions } from "../store.js";
import { checkRequired, clearFieldErrors, confirmDialog, fillForm, formValues, setFieldError, toast, toastError, withBusy } from "../ui.js";
import { esc, GSTIN_PATTERN, icons } from "../utils.js";

const LABELS = {
  business_name: "Business name", gstin: "GSTIN", pan: "PAN", state_code: "State", ifsc: "IFSC",
  account_number: "Account number", invoice_prefix: "Invoice prefix", invoice_suffix: "Invoice suffix", invoice_digits: "Digits in number", invoice_start_number: "Invoice start number",
  email: "Email", phone: "Phone", upi_id: "UPI ID", default_payment_terms_days: "Default payment terms days",
};

export async function render({ el, setTitle, isCurrent }) {
  setTitle("Settings");
  const [meta, settings] = await Promise.all([getMeta(), getSettings({ fresh: true })]);
  if (!isCurrent()) return;

  el.innerHTML = `
    ${settings.is_configured ? "" : `<div class="banner banner-info">${icons.info}<div><b>Welcome!</b> Enter your business details below. They appear on every invoice and decide how GST is split.</div></div>`}
    <form id="settings-form" class="settings-layout" novalidate>
      <nav class="settings-nav">
        <a href="#/settings" data-jump="biz">Business profile</a>
        <a href="#/settings" data-jump="logo">Logo</a>
        <a href="#/settings" data-jump="tax">Tax &amp; address</a>
        <a href="#/settings" data-jump="bank">Bank &amp; UPI</a>
        <a href="#/settings" data-jump="invoice">Invoice preferences</a>
        <a href="#/settings" data-jump="export">Export data</a>
      </nav>
      <div>
        <div class="card" id="sec-biz">
          <div class="card-header"><div><h2>Business profile</h2><p>Shown at the top of your invoices.</p></div></div>
          <div class="card-body form-grid">
            <div class="field span-2"><label class="req" for="s-name">Business name</label><input id="s-name" name="business_name" maxlength="200"></div>
            <div class="field"><label for="s-phone">Phone</label><input id="s-phone" name="phone" type="tel" maxlength="20"></div>
            <div class="field"><label for="s-email">Email</label><input id="s-email" name="email" type="email" maxlength="200"></div>
          </div>
        </div>

        <div class="card" id="sec-logo">
          <div class="card-header"><div><h2>Logos</h2><p>PNG or JPEG, up to 2 MB each. Up to 3 logos are printed across the top of the invoice: the first at the left, the last at the right. Use the slider to set the size of each logo, then press Save settings.</p></div></div>
          <div class="card-body">
            <div class="logo-grid">
              ${[1, 2, 3].map((slot) => `
              <div class="logo-slot" data-slot="${slot}">
                <div class="d-label-ui">Logo ${slot}</div>
                <div class="logo-preview" data-logo-preview></div>
                <input type="file" accept="image/png,image/jpeg" data-logo-input hidden>
                <button type="button" class="btn" data-logo-upload data-busy="Uploading…">${icons.upload}Upload</button>
                <button type="button" class="btn btn-ghost btn-danger" data-logo-remove>Remove</button>
                <label class="logo-size">Height on invoice: <b data-size-label></b> mm
                  <input type="range" min="8" max="40" step="1" data-logo-size></label>
              </div>`).join("")}
            </div>
          </div>
        </div>

        <div class="card" id="sec-tax">
          <div class="card-header"><div><h2>Tax &amp; address</h2><p>Your state decides CGST + SGST (same state) or IGST (other states).</p></div></div>
          <div class="card-body form-grid">
            <div class="field span-2"><label for="s-address">Business address</label><textarea id="s-address" name="address" rows="3" maxlength="1000"></textarea></div>
            <div class="field"><label class="req" for="s-state">State</label><select id="s-state" name="state_code">${stateOptions(meta.states)}</select></div>
            <div class="field"><label for="s-gstin">GSTIN</label><input id="s-gstin" name="gstin" maxlength="15" style="text-transform:uppercase"><div class="field-hint" data-gstin-hint></div></div>
            <div class="field"><label for="s-pan">PAN</label><input id="s-pan" name="pan" maxlength="10" style="text-transform:uppercase" placeholder="ABCDE1234F"></div>
          </div>
        </div>

        <div class="card" id="sec-bank">
          <div class="card-header"><div><h2>Bank &amp; UPI</h2><p>Printed in the payment section of the invoice.</p></div></div>
          <div class="card-body form-grid">
            <div class="field"><label for="s-bank">Bank name</label><input id="s-bank" name="bank_name" maxlength="200"></div>
            <div class="field"><label for="s-branch">Branch</label><input id="s-branch" name="bank_branch" maxlength="200" placeholder="e.g. Anna Salai, Chennai"></div>
            <div class="field"><label for="s-acname">Account holder name</label><input id="s-acname" name="account_name" maxlength="200" placeholder="Defaults to business name"></div>
            <div class="field"><label for="s-acno">Account number</label><input id="s-acno" name="account_number" maxlength="40" inputmode="numeric"></div>
            <div class="field"><label for="s-ifsc">IFSC</label><input id="s-ifsc" name="ifsc" maxlength="11" style="text-transform:uppercase" placeholder="SBIN0001234"></div>
            <div class="field"><label for="s-upi">UPI ID</label><input id="s-upi" name="upi_id" maxlength="100" placeholder="business@bank"></div>
          </div>
        </div>

        <div class="card" id="sec-invoice">
          <div class="card-header"><div><h2>Invoice preferences</h2><p>Numbering and default text for new invoices.</p></div></div>
          <div class="card-body form-grid">
            <div class="field"><label for="s-prefix">Invoice prefix</label><input id="s-prefix" name="invoice_prefix" maxlength="20" placeholder="INV-"></div>
            <div class="field"><label for="s-suffix">Invoice suffix</label><input id="s-suffix" name="invoice_suffix" maxlength="20" placeholder="FY2627"></div>
            <div class="field"><label for="s-digits">Digits in number</label><input id="s-digits" name="invoice_digits" type="number" min="1" max="8" step="1"><div class="field-hint">3 gives 001, 002 … 132</div></div>
            <div class="field"><label for="s-start">Starting number</label><input id="s-start" name="invoice_start_number" type="number" min="1" step="1"></div>
            <div class="field span-2"><div class="field-hint">Next invoice number: <b data-next-number>${esc(settings.next_invoice_number)}</b>. Format: prefix + number + suffix. If you type a number by hand (e.g. 120), the next one continues from 121. Numbers are never reused, even if an invoice is deleted.</div></div>
            <div class="field span-2"><label for="s-tc">Terms &amp; conditions</label><textarea id="s-tc" name="invoice_terms" rows="4" maxlength="3000"></textarea></div>
            <div class="field span-2"><label for="s-notes">Default customer notes</label><textarea id="s-notes" name="invoice_notes" rows="2" maxlength="2000"></textarea></div>
          </div>
        </div>

        <div class="card" id="sec-footer">
          <div class="card-header"><div><h2>Invoice footer (letterhead)</h2><p>The contact strip at the bottom of every invoice page. Leave a line empty to hide it. Switch it off to print your own letterhead image instead.</p></div>
            <label class="switch"><input type="checkbox" name="footer_enabled" data-footer-on><span class="switch-track"></span><span data-footer-state></span></label></div>
          <div class="card-body form-grid" data-footer-text>
            <div class="field"><label for="s-fphone">Call number</label><input id="s-fphone" name="footer_phone" maxlength="100"></div>
            <div class="field"><label for="s-fwa">WhatsApp number</label><input id="s-fwa" name="footer_whatsapp" maxlength="100"><label class="check" style="display:flex;gap:6px;align-items:center;margin-top:6px;font-weight:400"><input type="checkbox" data-wa-same> Same as call number</label></div>
            <div class="field"><label for="s-femail">Email</label><input id="s-femail" name="footer_email" maxlength="200"></div>
            <div class="field span-2"><label for="s-faddr">Address line</label><input id="s-faddr" name="footer_address" maxlength="500"></div>
          </div>
          <div class="card-body footer-image" data-footer-image>
            <div class="d-label-ui">Footer image</div>
            <p class="sub">PNG or JPEG, up to 2 MB. Printed across the full width at the bottom of every page, below the invoice border.</p>
            <div class="footer-preview" data-footer-preview></div>
            <label class="logo-size" data-footer-size-wrap>Height on invoice: <b data-footer-size-label></b> mm
              <input type="range" name="footer_image_height" min="10" max="50" step="1" data-footer-size></label>
            <div class="field-hint">The image always spans the full invoice width; only its height changes. Press Save settings to apply.</div>
            <input type="file" accept="image/png,image/jpeg" data-footer-input hidden>
            <div class="footer-actions">
              <button type="button" class="btn" data-footer-upload data-busy="Uploading…">${icons.upload}Upload image</button>
              <button type="button" class="btn btn-ghost btn-danger" data-footer-remove>Remove</button>
            </div>
          </div>
        </div>

        <div class="card" id="sec-export">
          <div class="card-header"><div><h2>Export data</h2><p>Download everything as one Excel workbook for backup or accounting.</p></div></div>
          <div class="card-body">
            <p class="modal-text">The file has five sheets: <b>Business</b> details, <b>Customers</b>, <b>Products</b> (the full catalogue), <b>Invoices</b> and <b>Invoice Items</b>. It includes your bank details, so keep the file private.</p>
            <a class="btn btn-primary" href="api/export/xlsx" download data-export>${icons.download}Download all data (.xlsx)</a>
          </div>
        </div>

        <div class="sticky-footer"><span class="sub" data-status></span><span class="spacer"></span><button type="submit" class="btn btn-primary btn-lg" data-shortcut="save" title="Ctrl+S">Save settings</button></div>
      </div>
    </form>`;

  const form = el.querySelector("#settings-form");
  fillForm(form, settings);

  el.querySelectorAll("[data-jump]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    el.querySelector(`#sec-${link.dataset.jump}`).scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  const hint = el.querySelector("[data-gstin-hint]");
  const checkGstin = () => {
    const value = form.gstin.value.trim().toUpperCase();
    hint.className = "field-hint";
    hint.textContent = "";
    if (!value) return;
    if (!GSTIN_PATTERN.test(value)) {
      hint.className = "field-hint warn";
      hint.textContent = "This doesn't look like a standard 15-character GSTIN.";
    } else if (!form.state_code.value) {
      form.state_code.value = value.slice(0, 2);
    } else if (form.state_code.value !== value.slice(0, 2)) {
      hint.className = "field-hint warn";
      hint.textContent = `GSTIN state code ${value.slice(0, 2)} differs from the selected state.`;
    }
  };
  form.gstin.addEventListener("input", checkGstin);
  form.state_code.addEventListener("change", checkGstin);
  checkGstin();

  // Logos (three slots)
  el.querySelectorAll(".logo-slot").forEach((box) => {
    const slot = Number(box.dataset.slot);
    const preview = box.querySelector("[data-logo-preview]");
    const removeBtn = box.querySelector("[data-logo-remove]");
    const fileInput = box.querySelector("[data-logo-input]");
    const uploadBtn = box.querySelector("[data-logo-upload]");
    const sizeInput = box.querySelector("[data-logo-size]");
    const sizeLabel = box.querySelector("[data-size-label]");
    sizeInput.value = (settings.logo_heights || [])[slot - 1] || 20;
    const showSize = () => {
      sizeLabel.textContent = sizeInput.value;
      const img = preview.querySelector("img");
      if (img) img.style.height = `${(sizeInput.value / 40) * 100}%`;
    };
    sizeInput.addEventListener("input", showSize);
    const show = (has) => {
      preview.innerHTML = has ? `<img src="${api.logoUrl(slot)}" alt="Logo ${slot}">` : "No logo";
      removeBtn.hidden = !has;
      sizeInput.closest("label").hidden = !has;
      showSize();
    };
    show((settings.logos || [])[slot - 1]);
    uploadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { toast("Logo must be smaller than 2 MB.", "error"); return; }
      try {
        setSettings(await withBusy(uploadBtn, () => api.uploadLogo(file, slot)));
        show(true);
        toast(`Logo ${slot} uploaded`);
      } catch (error) { toastError(error); }
    });
    removeBtn.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: `Remove logo ${slot}?`, message: "Future invoices will be generated without it.", confirmText: "Remove", danger: true }))) return;
      try {
        setSettings(await api.deleteLogo(slot));
        show(false);
        toast(`Logo ${slot} removed`);
      } catch (error) { toastError(error); }
    });
  });

  // Footer: text strip on, or off with an optional letterhead image
  const footerOn = form.querySelector("[data-footer-on]");
  const footerText = el.querySelector("[data-footer-text]");
  const footerImage = el.querySelector("[data-footer-image]");
  const footerPreview = el.querySelector("[data-footer-preview]");
  const footerInput = el.querySelector("[data-footer-input]");
  const footerUpload = el.querySelector("[data-footer-upload]");
  const footerRemove = el.querySelector("[data-footer-remove]");
  const showFooterMode = () => {
    footerText.hidden = !footerOn.checked;
    footerImage.hidden = footerOn.checked;
    el.querySelector("[data-footer-state]").textContent = footerOn.checked ? "On" : "Off";
  };
  const footerSize = el.querySelector("[data-footer-size]");
  const showFooterSize = () => {
    el.querySelector("[data-footer-size-label]").textContent = footerSize.value;
    const img = footerPreview.querySelector("img");
    if (img) img.style.aspectRatio = `190 / ${footerSize.value}`;  // same shape as on the 190 mm wide invoice
  };
  footerSize.addEventListener("input", showFooterSize);
  const showFooterImage = (has) => {
    footerPreview.innerHTML = has ? `<img src="${api.footerImageUrl()}" alt="Footer image">` : "No footer image";
    footerRemove.hidden = !has;
    el.querySelector("[data-footer-size-wrap]").hidden = !has;
    showFooterSize();
  };
  footerOn.addEventListener("change", showFooterMode);
  showFooterMode();
  showFooterImage(settings.has_footer_image);
  footerUpload.addEventListener("click", () => footerInput.click());
  footerInput.addEventListener("change", async () => {
    const file = footerInput.files[0];
    footerInput.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast("Footer image must be smaller than 2 MB.", "error"); return; }
    try {
      setSettings(await withBusy(footerUpload, () => api.uploadFooterImage(file)));
      showFooterImage(true);
      toast(footerOn.checked ? "Footer image uploaded" : "Footer image uploaded. Press Save settings if you just switched the footer off.");
    } catch (error) { toastError(error); }
  });
  footerRemove.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: "Remove footer image?", message: "Invoices will be generated without it.", confirmText: "Remove", danger: true }))) return;
    try {
      setSettings(await api.deleteFooterImage());
      showFooterImage(false);
      toast("Footer image removed");
    } catch (error) { toastError(error); }
  });

  const waSame = form.querySelector("[data-wa-same]");
  const phoneInput = form.elements.footer_phone;
  const waInput = form.elements.footer_whatsapp;
  const syncWhatsapp = () => {
    if (waSame.checked) waInput.value = phoneInput.value;
    waInput.disabled = waSame.checked;
  };
  waSame.checked = !waInput.value || waInput.value === phoneInput.value;
  waSame.addEventListener("change", syncWhatsapp);
  phoneInput.addEventListener("input", () => { if (waSame.checked) syncWhatsapp(); });
  syncWhatsapp();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!checkRequired(form, { business_name: "Business name", state_code: "State" })) {
      toast("Please fill the required fields.", "error");
      return;
    }
    const data = formValues(form);
    for (const key of ["gstin", "pan", "ifsc"]) data[key] = data[key].toUpperCase();
    data.footer_whatsapp = waSame.checked ? data.footer_phone : (data.footer_whatsapp || "");
    data.invoice_start_number = Number(data.invoice_start_number || 1);
    data.invoice_digits = Number(data.invoice_digits || 3);
    data.logo_heights = [...el.querySelectorAll("[data-logo-size]")].map((input) => Number(input.value));
    data.footer_image_height = Number(data.footer_image_height || 30);
    try {
      const updated = await withBusy(form.querySelector('button[type="submit"]'), () => api.saveSettings(data));
      setSettings(updated);
      el.querySelector("[data-next-number]").textContent = updated.next_invoice_number;
      clearFieldErrors(form);
      toast("Settings saved");
    } catch (error) {
      const match = Object.entries(LABELS).find(([, label]) => error.message.toLowerCase().startsWith(label.toLowerCase() + ":"));
      if (match) {
        setFieldError(form, match[0], error.message.slice(match[1].length + 1).trim());
        form.querySelector(`[name="${match[0]}"]`).scrollIntoView({ block: "center" });
      }
      toastError(error);
    }
  });
}
