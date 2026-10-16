// Application shell: hash router, navigation state and unsaved-changes guard.
import { esc } from "./js/utils.js";
import { closeAllModals, confirmDialog, toastError } from "./js/ui.js";
import { getSettings, setSettings } from "./js/store.js";
import * as dashboard from "./js/views/dashboard.js";
import * as invoices from "./js/views/invoices.js";
import * as invoiceForm from "./js/views/invoice-form.js";
import * as invoiceView from "./js/views/invoice-view.js";
import * as customers from "./js/views/customers.js";
import * as products from "./js/views/products.js";
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
  { pattern: /^\/products$/, view: products, nav: "products" },
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

function setTitle(title, crumb = "") {
  document.getElementById("page-title").textContent = title;
  document.getElementById("crumb").innerHTML = crumb;
  document.title = `${title} · Billing`;
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

  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === route.nav));
  document.body.classList.remove("nav-open");
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
    container.innerHTML = `<div class="card empty"><h3>Could not load this page</h3><p>${esc(error.message || "Unexpected error")}</p>
      <button class="btn" onclick="location.reload()">Retry</button></div>`;
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

document.getElementById("menu-btn").addEventListener("click", () => document.body.classList.toggle("nav-open"));
document.getElementById("sidebar-backdrop").addEventListener("click", () => document.body.classList.remove("nav-open"));

window.addEventListener("unhandledrejection", (event) => {
  console.error(event.reason);
  toastError(event.reason);
});

if (!location.hash) location.replace("#/dashboard");
currentHash = location.hash;
getSettings().then(setSettings).catch(() => {});
render();
