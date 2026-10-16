// Thin fetch wrapper. Errors surface the backend's user-friendly "detail" message.

export class ApiError extends Error {
  constructor(message, status, errors = []) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

async function request(method, path, body, { isForm = false } = {}) {
  const options = { method, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    if (isForm) {
      options.body = body;
    } else {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError("Cannot reach the server. Check that the application is running.", 0);
  }

  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* non-JSON response */
  }
  if (!response.ok) {
    const message = (data && typeof data.detail === "string" && data.detail) || `Request failed (${response.status}).`;
    throw new ApiError(message, response.status, (data && data.errors) || []);
  }
  return data;
}

function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const api = {
  meta: () => request("GET", "/api/meta"),
  dashboard: () => request("GET", "/api/dashboard"),
  dashboardOverview: (params) => request("GET", "/api/dashboard/overview" + query(params)),

  customers: (params) => request("GET", "/api/customers" + query(params)),
  customer: (id) => request("GET", `/api/customers/${id}`),
  createCustomer: (data) => request("POST", "/api/customers", data),
  updateCustomer: (id, data) => request("PUT", `/api/customers/${id}`, data),
  deleteCustomer: (id) => request("DELETE", `/api/customers/${id}`),

  products: (params) => request("GET", "/api/products" + query(params)),
  createProduct: (data) => request("POST", "/api/products", data),
  updateProduct: (id, data) => request("PUT", `/api/products/${id}`, data),
  deleteProduct: (id) => request("DELETE", `/api/products/${id}`),

  invoices: (params) => request("GET", "/api/invoices" + query(params)),
  invoice: (id) => request("GET", `/api/invoices/${id}`),
  nextInvoiceNumber: () => request("GET", "/api/invoices/next-number"),
  previewInvoice: (data, invoiceId) => request("POST", "/api/invoices/preview" + query({ invoice_id: invoiceId }), data),
  createInvoice: (data) => request("POST", "/api/invoices", data),
  updateInvoice: (id, data) => request("PUT", `/api/invoices/${id}`, data),
  deleteInvoice: (id) => request("DELETE", `/api/invoices/${id}`),
  setInvoiceStatus: (id, status) => request("PATCH", `/api/invoices/${id}/status`, { status }),
  recordPayment: (id, amount) => request("POST", `/api/invoices/${id}/payments`, { amount }),
  regeneratePdf: (id) => request("POST", `/api/invoices/${id}/pdf/regenerate`),
  pdfUrl: (id, download = false) => `/api/invoices/${id}/pdf${download ? "?download=true" : ""}`,

  settings: () => request("GET", "/api/settings"),
  saveSettings: (data) => request("PUT", "/api/settings", data),
  uploadLogo: (file, slot = 1) => {
    const form = new FormData();
    form.append("file", file);
    return request("POST", `/api/settings/logo?slot=${slot}`, form, { isForm: true });
  },
  importProducts: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request("POST", "/api/products/import", form, { isForm: true });
  },
  deleteLogo: (slot = 1) => request("DELETE", `/api/settings/logo?slot=${slot}`),
  logoUrl: (slot = 1) => `/api/settings/logo?slot=${slot}&v=${Date.now()}`,
  logoHeights: (settings) => (settings.logos || []).map((has, i) => (has ? (settings.logo_heights || [])[i] || 20 : null)).filter((h) => h !== null),
  logoUrls: (settings) => (settings.logos || []).map((has, i) => (has ? api.logoUrl(i + 1) : null)).filter(Boolean),
};
