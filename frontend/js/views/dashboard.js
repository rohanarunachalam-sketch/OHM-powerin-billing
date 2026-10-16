import { api } from "../api.js";
import { setSettings, getSettings } from "../store.js";
import { emptyState, skeletonStats, skeletonTable, toastError } from "../ui.js";
import { addDays, esc, fmtDate, icons, money, paise, todayISO } from "../utils.js";
import { bindInvoiceList, invoiceTable } from "./invoices.js";

const RANGES = [
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
  { key: "365", label: "12 months", days: 365 },
  { key: "custom", label: "Custom" },
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pluralise = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2026-10-12" -> "12 Oct"; "2026-10" -> "Oct 26" */
function shortLabel(label) {
  const parts = label.split("-");
  return parts.length === 3 ? `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]}` : `${MONTHS[Number(parts[1]) - 1]} ${parts[0].slice(2)}`;
}

/** Compact axis value, e.g. 250000 -> "2.5L", 12000 -> "12K" (display only). */
function axisValue(rupees) {
  if (rupees >= 1e7) return `${+(rupees / 1e7).toFixed(1)}Cr`;
  if (rupees >= 1e5) return `${+(rupees / 1e5).toFixed(1)}L`;
  if (rupees >= 1e3) return `${+(rupees / 1e3).toFixed(1)}K`;
  return String(Math.round(rupees));
}

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= value) * magnitude;
  return step;
}

/** Bar chart drawn as inline SVG: amounts come straight from the backend, nothing is recalculated. */
function salesChart(series, width) {
  const W = Math.max(420, width), H = 250, left = 52, right = 8, top = 10, bottom = 26;
  const values = series.map((p) => Number(p.total));
  const max = niceMax(Math.max(...values, 0));
  const plotW = W - left - right, plotH = H - top - bottom;
  const slot = plotW / series.length;
  const barW = Math.max(2, Math.min(34, slot * 0.64));
  const y = (v) => top + plotH - (v / max) * plotH;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = max * f;
    return `<line class="grid-line" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${left - 8}" y="${y(v) + 4}" text-anchor="end">₹${axisValue(v)}</text>`;
  }).join("");
  const every = Math.max(1, Math.ceil(series.length / 8));
  const bars = series.map((p, i) => {
    const v = Number(p.total);
    const x = left + i * slot + (slot - barW) / 2;
    const h = Math.max(v > 0 ? 2 : 0, (v / max) * plotH);
    const label = i % every === 0 ? `<text class="axis" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${shortLabel(p.label)}</text>` : "";
    return `<g><rect class="bar-rect" x="${x}" y="${top + plotH - h}" width="${barW}" height="${h}" rx="2"><title>${shortLabel(p.label)}: ${money(p.total)}</title></rect>${label}</g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales over the selected period">${grid}${bars}</svg>`;
}

export async function render({ el, setTitle, isCurrent }) {
  setTitle("Dashboard");
  el.innerHTML = `
    <div class="page-head">
      <div><h2>Dashboard</h2><p>Your sales, collections and what is still owed — at a glance.</p></div>
      <div class="page-actions"><a class="btn btn-primary btn-lg" href="#/invoices/new">${icons.plus}Create Invoice</a></div>
    </div>
    ${skeletonStats(4)}
    <div class="card"><div style="padding:20px">${skeletonTable(4)}</div></div>`;

  const [d, settings] = await Promise.all([api.dashboard(), getSettings({ fresh: true })]);
  if (!isCurrent()) return;
  setSettings(settings);

  const steps = [
    { done: d.business_configured, title: "Business profile", desc: "Name, GSTIN, state, bank", href: "#/settings" },
    { done: d.customer_count > 0, title: "Add a customer", desc: "Who you bill", href: "#/customers" },
    { done: d.product_count > 0, title: "Add products", desc: "Items with HSN & GST", href: "#/products" },
    { done: d.invoice_count + d.draft_count > 0, title: "Create an invoice", desc: "Preview & download PDF", href: "#/invoices/new" },
  ];
  const setupDone = steps.every((s) => s.done);

  const kpi = (cls, label, iconName, value, meta) => `
    <div class="card stat ${cls}">
      <div class="stat-label">${label}<span class="stat-icon" aria-hidden="true">${icons[iconName]}</span></div>
      <div class="stat-value" title="${esc(value)}">${value}</div>
      <div class="stat-meta">${meta}</div>
    </div>`;

  const total = paise(d.total_sales) || 0n;
  const share = (value) => (total > 0n ? Number(((paise(value) || 0n) * 1000n) / total) / 10 : 0);
  const segments = [
    { label: "Paid", value: d.paid, color: "var(--success)" },
    { label: "Pending", value: d.pending, color: "#d89614" },
    { label: "Overdue", value: d.overdue, color: "var(--danger)" },
  ];

  const emptyInvoices = emptyState({
    icon: icons.doc, title: "No invoices yet", text: "Create your first invoice and start tracking your sales.",
    actionHtml: `<a class="btn btn-primary" href="#/invoices/new">${icons.plus}Create Invoice</a>`,
  });

  el.innerHTML = `
    <div class="page-head">
      <div><h2>Dashboard</h2><p>${settings.business_name ? `${esc(settings.business_name)} · ` : ""}Your sales, collections and what is still owed — at a glance.</p></div>
      <div class="page-actions"><a class="btn btn-primary btn-lg" href="#/invoices/new">${icons.plus}Create Invoice</a></div>
    </div>

    ${setupDone ? "" : `
      <div class="card setup">
        <h2>Get started${settings.business_name ? `, ${esc(settings.business_name)}` : ""}</h2>
        <p>Four quick steps to your first GST invoice.</p>
        <div class="steps">${steps.map((s, i) => `
          <a class="step ${s.done ? "done" : ""}" href="${s.href}">
            <span class="step-num">${s.done ? "✓" : i + 1}</span>
            <span><span class="step-title">${s.title}</span><br><span class="step-desc">${s.desc}</span></span>
          </a>`).join("")}
        </div>
      </div>`}

    <div class="stats">
      ${kpi("", "Total Sales", "receipt", money(d.total_sales, { decimals: 0 }),
        `${pluralise(d.invoice_count, "invoice")} issued · <b>${money(d.this_month_sales, { decimals: 0 })}</b> this month`)}
      ${kpi("pending", "Outstanding", "clock", money(d.outstanding, { decimals: 0 }),
        `${pluralise(d.outstanding_count, "invoice")} awaiting payment`)}
      ${kpi("paid", "Received", "checkCircle", money(d.paid, { decimals: 0 }),
        d.paid_percent === null ? "No sales yet" : `<b>${d.paid_percent}%</b> of sales collected`)}
      ${kpi("overdue", "Overdue", "alert", money(d.overdue, { decimals: 0 }),
        `${pluralise(d.overdue_count, "invoice")} past due`)}
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <div><h2>Sales overview</h2><p data-range-text></p></div>
        <div class="page-actions">
          <div class="range" role="group" aria-label="Date range">${RANGES.map((r) => `<button type="button" data-range="${r.key}" aria-pressed="${r.key === "30"}">${r.label}</button>`).join("")}</div>
        </div>
      </div>
      <div class="range-custom" data-custom hidden style="padding:12px 20px 0">
        <label class="sr-only" for="dash-from">From</label><input id="dash-from" type="date" data-from>
        <span class="sub">to</span>
        <label class="sr-only" for="dash-to">To</label><input id="dash-to" type="date" data-to>
        <button type="button" class="btn btn-sm" data-apply>Apply</button>
      </div>
      <div class="chart-head"><div><div class="chart-total" data-total>—</div><div class="stat-meta" data-compare></div></div></div>
      <div class="chart" data-chart>${skeletonTable(3)}</div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header"><div><h2>Recent invoices</h2></div><a class="btn btn-sm" href="#/invoices">View all</a></div>
        <div data-recent>${d.recent_invoices.length ? invoiceTable(d.recent_invoices, { compact: true }) : emptyInvoices}</div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-header"><div><h2>Receivables</h2><p>Share of billed value</p></div></div>
          <div class="card-body">
            <div class="bar" style="display:flex;gap:2px;height:10px;background:${total > 0n ? "transparent" : "var(--surface-3)"}" role="img"
                 aria-label="${segments.map((s) => `${s.label} ${share(s.value)}%`).join(", ")}">
              ${segments.filter((s) => share(s.value) > 0).map((s) => `<span title="${s.label}: ${money(s.value)}" style="width:${share(s.value)}%;background:${s.color}"></span>`).join("")}
            </div>
            <ul class="list" style="margin:12px -20px -20px">
              ${segments.map((s) => `<li><span><span class="dot" style="background:${s.color}"></span>${s.label}</span>
                <span><b>${money(s.value)}</b> <span class="sub">${share(s.value)}%</span></span></li>`).join("")}
            </ul>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><div><h2>Who owes you</h2><p>Customers with open balances</p></div></div>
          <div data-owing><div style="padding:20px">${skeletonTable(2)}</div></div>
        </div>
      </div>
    </div>`;

  bindInvoiceList(el.querySelector("[data-recent]"), { items: () => d.recent_invoices, reload: () => render({ el, setTitle, isCurrent }) });

  // ---- Sales overview (date range) ----
  const $ = (selector) => el.querySelector(selector);
  const fromInput = $("[data-from]");
  const toInput = $("[data-to]");
  let activeRange = "30";

  async function loadOverview(params) {
    $("[data-chart]").innerHTML = skeletonTable(3);
    try {
      const o = await api.dashboardOverview(params);
      if (!isCurrent()) return;
      fromInput.value = o.date_from;
      toInput.value = o.date_to;
      $("[data-range-text]").textContent = `${fmtDate(o.date_from)} – ${fmtDate(o.date_to)}`;
      $("[data-total]").textContent = money(o.total, { decimals: 0 });
      const change = o.change_percent;
      $("[data-compare]").innerHTML = `${pluralise(o.invoice_count, "invoice")}` + (change === null
        ? " · no sales in the previous period to compare"
        : ` · <span class="trend ${change >= 0 ? "up" : "down"}">${change >= 0 ? "▲" : "▼"} ${Math.abs(change)}%</span> vs previous period (${money(o.previous_total, { decimals: 0 })})`);
      $("[data-chart]").innerHTML = Number(o.total) > 0
        ? salesChart(o.series, $("[data-chart]").clientWidth - 24)
        : emptyState({ icon: icons.chart, title: "No sales in this period", text: "Issued invoices in the selected dates will appear here." });

      $("[data-owing]").innerHTML = o.outstanding_customers.length
        ? `<ul class="list">${o.outstanding_customers.map((c) => `<li>
            <span>${c.customer_id ? `<a href="#/customers/${c.customer_id}">${esc(c.name)}</a>` : esc(c.name)}<br><span class="sub">${pluralise(c.invoice_count, "open invoice")}</span></span>
            <b class="balance-pos">${money(c.balance)}</b></li>`).join("")}</ul>`
        : emptyState({ icon: icons.checkCircle, title: "All caught up", text: "No customer owes you anything right now." });
    } catch (error) { toastError(error); }
  }

  const setRange = (key) => {
    activeRange = key;
    el.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === key)));
    $("[data-custom]").hidden = key !== "custom";
    if (key === "custom") return;
    const days = RANGES.find((r) => r.key === key).days;
    loadOverview({ date_from: addDays(todayISO(), -(days - 1)), date_to: todayISO() });
  };
  el.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => setRange(b.dataset.range)));
  $("[data-apply]").addEventListener("click", () => {
    if (!fromInput.value || !toInput.value) return;
    loadOverview({ date_from: fromInput.value, date_to: toInput.value });
  });
  setRange(activeRange);
}
