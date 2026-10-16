// UI primitives: toasts, modals, confirm dialogs, autocomplete and form helpers.
import { esc, icons } from "./utils.js";

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message, type = "success") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML = `${type === "error" ? icons.alert : icons.check}<div>${esc(message)}</div>`;
  root.appendChild(el);
  setTimeout(() => el.remove(), type === "error" ? 6000 : 3500);
}

export const toastError = (error) => toast(error?.message || "Something went wrong.", "error");

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

let openModals = 0;

/**
 * Open a modal. `body` and `footer` are HTML strings (callers escape content).
 * Returns { el, close }. `onClose` runs once when dismissed.
 */
export function openModal({ title, body, footer = "", size = "", onClose } = {}) {
  const root = document.getElementById("modal-root");
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-header">
        <h3>${esc(title)}</h3>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icons.close}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ""}
    </div>`;
  root.appendChild(backdrop);
  openModals += 1;
  document.body.style.overflow = "hidden";

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    openModals -= 1;
    if (!openModals) document.body.style.overflow = "";
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === "Escape" && root.lastElementChild === backdrop) close();
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", close));

  const firstInput = backdrop.querySelector("input:not([type=hidden]), select, textarea");
  (firstInput || backdrop.querySelector(".modal")).focus?.();
  return { el: backdrop, close };
}

export function closeAllModals() {
  document.querySelectorAll("#modal-root .modal-backdrop [data-close]").forEach((btn) => btn.click());
}

/** Promise-based confirmation dialog. */
export function confirmDialog({ title, message, confirmText = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const { el, close } = openModal({
      title,
      size: "sm",
      body: `<p class="modal-text">${esc(message)}</p>`,
      footer: `
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="button" class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" data-ok>${esc(confirmText)}</button>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    const ok = el.querySelector("[data-ok]");
    ok.addEventListener("click", () => { answered = true; close(); resolve(true); });
    ok.focus();
  });
}

// ---------------------------------------------------------------------------
// Buttons & forms
// ---------------------------------------------------------------------------

/** Show a spinner on a button while an async action runs. */
export async function withBusy(button, action) {
  if (!button) return action();
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>${esc(button.dataset.busy || "Saving…")}`;
  try {
    return await action();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

/** Collect named inputs of a form into a plain object of trimmed strings / booleans. */
export function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") values[el.name] = el.checked;
    else if (el.type === "file") continue;
    else values[el.name] = el.value.trim();
  }
  return values;
}

export function fillForm(form, data) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in data)) continue;
    if (el.type === "checkbox") el.checked = Boolean(data[el.name]);
    else el.value = data[el.name] ?? "";
  }
}

export function clearFieldErrors(form) {
  form.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
  form.querySelectorAll(".field-error").forEach((el) => el.remove());
}

export function setFieldError(form, name, message) {
  const input = form.querySelector(`[name="${name}"]`);
  if (!input) return;
  input.classList.add("invalid");
  const field = input.closest(".field") || input.parentElement;
  const error = document.createElement("div");
  error.className = "field-error";
  error.textContent = message;
  field.appendChild(error);
}

/** Validate required fields client-side; returns true when the form is valid. */
export function checkRequired(form, fields) {
  clearFieldErrors(form);
  let firstInvalid = null;
  for (const [name, label] of Object.entries(fields)) {
    const input = form.querySelector(`[name="${name}"]`);
    if (input && !input.value.trim()) {
      setFieldError(form, name, `${label} is required.`);
      firstInvalid ??= input;
    }
  }
  firstInvalid?.focus();
  return !firstInvalid;
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

/**
 * Attach a dropdown to an input.
 *   source(query) -> Promise<items> | items
 *   render(item)  -> { title, subtitle }
 *   onSelect(item)
 *   action        -> optional { label, onClick(query) } shown at the end of the list
 */
export function autocomplete(input, { source, render, onSelect, action, minChars = 0 }) {
  const wrapper = input.parentElement;
  wrapper.classList.add("ac");
  const list = document.createElement("div");
  list.className = "ac-list";
  list.hidden = true;
  wrapper.appendChild(list);
  input.setAttribute("autocomplete", "off");

  let items = [];
  let active = -1;
  let requestId = 0;

  const hide = () => { list.hidden = true; active = -1; };
  const choose = (index) => {
    const item = items[index];
    if (!item) return;
    hide();
    onSelect(item);
  };

  async function refresh() {
    const q = input.value.trim();
    if (q.length < minChars) { hide(); return; }
    const id = ++requestId;
    const result = await source(q);
    if (id !== requestId) return;
    items = result.slice(0, 30);
    active = items.length ? 0 : -1;
    list.innerHTML = items.length
      ? items.map((item, index) => {
          const { title, subtitle } = render(item);
          return `<div class="ac-item${index === active ? " active" : ""}" data-index="${index}">
            <div class="t">${esc(title)}</div>${subtitle ? `<div class="s">${esc(subtitle)}</div>` : ""}</div>`;
        }).join("")
      : `<div class="ac-empty">No matches${q ? ` for “${esc(q)}”` : ""}</div>`;
    if (action) list.insertAdjacentHTML("beforeend", `<div class="ac-item ac-action" data-action>${esc(action.label)}</div>`);
    list.hidden = false;
  }

  const highlight = () => {
    list.querySelectorAll(".ac-item[data-index]").forEach((el, index) => el.classList.toggle("active", index === active));
    list.querySelector(".ac-item.active")?.scrollIntoView({ block: "nearest" });
  };

  // Opens on click, typing or ArrowDown — not on plain focus, so an autofocused field stays unobtrusive.
  input.addEventListener("click", () => { if (list.hidden) refresh(); });
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (event) => {
    if (list.hidden) {
      if (event.key === "ArrowDown") { refresh(); event.preventDefault(); }
      return;
    }
    if (event.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); highlight(); event.preventDefault(); }
    else if (event.key === "ArrowUp") { active = Math.max(active - 1, 0); highlight(); event.preventDefault(); }
    else if (event.key === "Enter" && active >= 0) { choose(active); event.preventDefault(); }
    else if (event.key === "Escape") hide();
  });
  input.addEventListener("blur", () => setTimeout(hide, 150));
  list.addEventListener("mousedown", (event) => {
    event.preventDefault(); // keep focus in the input
    const option = event.target.closest(".ac-item");
    if (!option) return;
    if (option.hasAttribute("data-action")) { hide(); action.onClick(input.value.trim()); }
    else choose(Number(option.dataset.index));
  });
}

export function emptyState({ icon = icons.doc, title, text, actionHtml = "" }) {
  return `<div class="empty"><div class="empty-icon">${icon}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${actionHtml}</div>`;
}

export function searchBox(placeholder, value = "") {
  return `<div class="search">${icons.search}<input type="search" placeholder="${esc(placeholder)}" value="${esc(value)}" data-search></div>`;
}
