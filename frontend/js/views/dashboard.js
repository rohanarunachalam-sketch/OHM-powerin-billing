import { api } from "../api.js";
import { setSettings, getSettings } from "../store.js";
import { emptyState } from "../ui.js";
import { esc, icons, money, paise } from "../utils.js";
import { bindRowLinks, invoiceTable } from "./invoices.js";

export async function render({ el, setTitle, isCurrent }) {
  setTitle("Dashboard");
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

  const stat = (cls, label, value, meta) => `
    <div class="card stat ${cls}">
      <div class="stat-label"><span class="stat-dot"></span>${label}</div>
      <div class="stat-value" title="${esc(value)}">${value}</div>
      <div class="stat-meta">${meta}</div>
    </div>`;

  // Receivables meter: share of billed value that is paid / pending / overdue.
  const total = paise(d.total_sales) || 0n;
  const share = (value) => (total > 0n ? Number(((paise(value) || 0n) * 1000n) / total) / 10 : 0);
  const segments = [
    { label: "Paid", value: d.paid, color: "var(--success)" },
    { label: "Pending", value: d.pending, color: "#f79009" },
    { label: "Overdue", value: d.overdue, color: "var(--danger)" },
  ];

  el.innerHTML = `
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
      ${stat("", "Total Sales", money(d.total_sales, { decimals: 0 }), `${money(d.this_month_sales, { decimals: 0 })} this month`)}
      ${stat("paid", "Paid", money(d.paid, { decimals: 0 }), "Payments received")}
      ${stat("pending", "Pending", money(d.pending, { decimals: 0 }), "Not yet due")}
      ${stat("overdue", "Overdue", money(d.overdue, { decimals: 0 }), `${d.overdue_count} invoice${d.overdue_count === 1 ? "" : "s"} past due`)}
      ${stat("count", "Invoices", String(d.invoice_count), `${d.draft_count} draft${d.draft_count === 1 ? "" : "s"}`)}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header"><div><h2>Recent invoices</h2></div><a class="btn btn-sm" href="#/invoices">View all</a></div>
        <div data-recent>${d.recent_invoices.length
          ? invoiceTable(d.recent_invoices)
          : emptyState({ title: "No invoices yet", text: "Your latest invoices will appear here.",
              actionHtml: `<a class="btn btn-primary" href="#/invoices/new">${icons.plus}Create Invoice</a>` })}
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-header"><h2>Receivables</h2></div>
          <div class="card-body">
            <div class="bar" style="display:flex;gap:2px;height:10px;background:${total > 0n ? "transparent" : "#eef1f6"}" role="img"
                 aria-label="${segments.map((s) => `${s.label} ${share(s.value)}%`).join(", ")}">
              ${segments.filter((s) => share(s.value) > 0).map((s) => `<span title="${s.label}: ${money(s.value)}" style="width:${share(s.value)}%;background:${s.color}"></span>`).join("")}
            </div>
            <ul class="list" style="margin:12px -20px -20px">
              ${segments.map((s) => `<li><span><span class="stat-dot" style="display:inline-block;background:${s.color};margin-right:8px"></span>${s.label}</span>
                <span><b>${money(s.value)}</b> <span class="sub">${share(s.value)}%</span></span></li>`).join("")}
            </ul>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h2>Quick actions</h2></div>
          <div class="action-list">
            <a class="btn" href="#/invoices/new">${icons.doc}New invoice</a>
            <a class="btn" href="#/customers">${icons.users}Customers <span class="sub" style="margin-left:auto">${d.customer_count}</span></a>
            <a class="btn" href="#/products">${icons.box}Products &amp; services <span class="sub" style="margin-left:auto">${d.product_count}</span></a>
            <a class="btn" href="#/payments">${icons.rupee}Record a payment</a>
          </div>
        </div>
      </div>
    </div>`;

  const recent = el.querySelector("[data-recent]");
  if (recent) bindRowLinks(recent);
}
