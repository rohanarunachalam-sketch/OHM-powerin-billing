import { icons } from "../utils.js";

// Reports are planned for Phase 2; this page says so plainly rather than showing fake data.
export async function render({ el, setTitle }) {
  setTitle("Reports", "Money");
  el.innerHTML = `
    <div class="card placeholder-page">
      <div class="empty-icon">${icons.doc}</div>
      <h2>Reports are coming in the next phase</h2>
      <p class="modal-text" style="margin-top:8px">Planned reports:</p>
      <ul>
        <li>Sales by customer, item and month</li>
        <li>GST summary (GSTR-1 style, HSN-wise)</li>
        <li>Receivables ageing</li>
        <li>CSV / Excel export</li>
      </ul>
      <div><a class="btn btn-primary" href="#/invoices">View invoices</a> <a class="btn" href="#/payments">View payments</a></div>
    </div>`;
}
