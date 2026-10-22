// Application shell: hash router, navigation state and unsaved-changes guard.
import { esc, icon } from "./js/utils.js";
import { closeAllModals, confirmDialog, toastError } from "./js/ui.js";
import { getSettings, setSettings } from "./js/store.js";
import * as dashboard from "./js/views/dashboard.js";
import * as invoices from "./js/views/invoices.js";
import * as invoiceForm from "./js/views/invoice-form.js";
import * as invoiceView from "./js/views/invoice-view.js";
import * as customers from "./js/views/customers.js";
import * as products from "./js/views/products.js";
import * as materials from "./js/views/materials.js";
import * as payments from "./js/views/payments.js";
import * as reports from "./js/views/reports.js";
import * as settings from "./js/views/settings.js";

const routes = [
  { pattern: /^\/dashboard$/, view: dashboard, nav: "dashboard" },
  { pattern: /^\/invoices$/, view: invoices, nav: "invoices" },
  { pattern: /^\/invoices\/new$/, view: invoiceForm, nav: "invoices" },
  { pattern: /^\/invoices\/(\d+)\/edit$/, view: invoiceForm, nav: "invoices", keys: ["id"] },
  { pattern: /^\/invoices\/(\d+)$/, view: invoiceView, nav: "invoices", keys: ["id"] },
  { pattern: /^\/customers$/, view: customers, nav: "customers" },
  { pattern: /^\/customers\/(\d+)$/, view: customers, nav: "customers", keys: ["id"] },
  { pattern: /^\/products$/, view: products, nav: "products" },
  { pattern: /^\/materials$/, view: materials, nav: "materials" },
  { pattern: /^\/payments$/, view: payments, nav: "payments" },
  { pattern: /^\/reports$/, view: reports, nav: "reports" },
  { pattern: /^\/settings$/, view: settings, nav: "settings" },
];

const viewEl = document.getElementById("view");
let leaveGuard = null;
let currentHash = location.hash;
let ignoreNextHashChange = false;
let renderToken = 0;

function parseHash() {
  const hash = location.hash.replace(/^#/, "") || "/dashboard";
  const [path, queryString = ""] = hash.split("?");
  return { path, query: Object.fromEntries(new URLSearchParams(queryString)) };
}

// Fill the static shell's icon placeholders from the shared icon set.
document.querySelectorAll("[data-icon]").forEach((node) => { node.outerHTML = icon(node.dataset.icon); });

function setTitle(title, crumb = "") {
  document.getElementById("page-title").textContent = title;
  document.getElementById("crumb").innerHTML = crumb;
  document.title = `${title} · OHM Powerin Billing`;
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/** Views call this to protect unsaved work. `isDirty` returns true when leaving should be confirmed. */
export function setLeaveGuard(isDirty) {
  leaveGuard = isDirty;
}

async function render() {
  const token = ++renderToken;
  const { path, query } = parseHash();
  const route = routes.find((r) => r.pattern.test(path));
  if (!route) {
    location.replace("#/dashboard");
    return;
  }
  const match = route.pattern.exec(path);
  const params = Object.fromEntries((route.keys || []).map((key, i) => [key, match[i + 1]]));

  document.querySelectorAll("[data-nav]").forEach((a) => {
    const active = a.dataset.nav === route.nav;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.body.dataset.route = route.nav;
  document.body.classList.remove("nav-open");
  document.getElementById("menu-btn").setAttribute("aria-expanded", "false");
  closeAllModals();
  leaveGuard = null;
  window.scrollTo(0, 0);
  // A fresh container per render, so listeners attached by the previous view are discarded.
  const container = document.createElement("div");
  container.innerHTML = '<div class="loading"><span class="spinner"></span>Loading…</div>';
  viewEl.replaceChildren(container);

  try {
    await route.view.render({
      el: container,
      params,
      query,
      setTitle,
      navigate,
      setLeaveGuard,
      isCurrent: () => token === renderToken,
    });
  } catch (error) {
    if (token !== renderToken) return;
    console.error(error);
    container.innerHTML = `<div class="card empty"><div class="empty-icon">${icon("alert")}</div><h3>This page could not be loaded</h3>
      <p>Please check your connection and try again. If the problem continues, restart the application.</p>
      <button class="btn" onclick="location.reload()">Try again</button></div>`;
  }
}

window.addEventListener("hashchange", async () => {
  if (ignoreNextHashChange) {
    ignoreNextHashChange = false;
    return;
  }
  if (leaveGuard && leaveGuard()) {
    const target = location.hash;
    ignoreNextHashChange = true;
    location.hash = currentHash;
    const leave = await confirmDialog({
      title: "Discard changes?",
      message: "You have unsaved changes on this invoice. Leave this page and discard them?",
      confirmText: "Discard changes",
      danger: true,
    });
    if (!leave) return;
    leaveGuard = null;
    location.hash = target;
    return;
  }
  currentHash = location.hash;
  render();
});

window.addEventListener("beforeunload", (event) => {
  if (leaveGuard && leaveGuard()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

document.getElementById("menu-btn").addEventListener("click", (event) => {
  const open = document.body.classList.toggle("nav-open");
  event.currentTarget.setAttribute("aria-expanded", String(open));
});
document.getElementById("sidebar-backdrop").addEventListener("click", () => document.body.classList.remove("nav-open"));

// Keyboard shortcuts. Views mark their buttons with data-shortcut="save" / "print"; the visible one is pressed.
// Esc (close the top modal) is handled by openModal; Enter (add item row) by the invoice form.
const visible = (node) => node && node.offsetParent !== null && !node.disabled;
const topModal = () => document.querySelector("#modal-root > .modal-backdrop:last-child");

function shortcutTarget(name) {
  const scope = topModal() || viewEl;
  return [...scope.querySelectorAll(`[data-shortcut="${name}"]`)].find(visible) || null;
}

document.addEventListener("keydown", (event) => {
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (event.repeat) return;
  // Ctrl+N: browsers keep it for "new window", so Alt+N works as well.
  if ((ctrl && !event.shiftKey && key === "n") || (event.altKey && !ctrl && key === "n")) {
    event.preventDefault();
    if (topModal()) return;
    navigate("#/invoices/new");
    return;
  }
  if (ctrl && !event.shiftKey && !event.altKey && key === "s") {
    event.preventDefault();  // never the browser's "Save page as"
    const modal = topModal();
    const target = modal
      ? [...modal.querySelectorAll('button[type="submit"]')].find(visible)
      : shortcutTarget("save");
    target?.click();
    return;
  }
  if (ctrl && !event.shiftKey && !event.altKey && key === "p") {
    const target = topModal() ? null : shortcutTarget("print");
    if (!target) return;  // nothing to preview here: let the browser print the page
    event.preventDefault();
    target.click();
  }
});

window.addEventListener("unhandledrejection", (event) => {
  console.error(event.reason);
  toastError(event.reason);
});

if (!location.hash) location.replace("#/dashboard");
currentHash = location.hash;
getSettings().then(setSettings).catch(() => {});
render();
