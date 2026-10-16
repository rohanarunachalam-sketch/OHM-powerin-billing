// Cached reference data shared across views.
import { api } from "./api.js";

let metaPromise = null;
let settingsCache = null;

export function getMeta() {
  metaPromise ??= api.meta().catch((error) => {
    metaPromise = null;
    throw error;
  });
  return metaPromise;
}

export async function getSettings({ fresh = false } = {}) {
  if (!settingsCache || fresh) settingsCache = await api.settings();
  return settingsCache;
}

export function setSettings(settings) {
  settingsCache = settings;
  const name = settings.business_name || "Your business";
  const set = (id, text) => { const node = document.getElementById(id); if (node) node.textContent = text; };
  set("account-name", name);
  set("account-sub", settings.gstin ? `GSTIN ${settings.gstin}` : settings.business_name ? "GST billing" : "Set up in Settings");
  set("account-avatar", name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "OP");
}

export function stateOptions(states, selected = "", placeholder = "Select state") {
  return `<option value="">${placeholder}</option>` + states
    .map((s) => `<option value="${s.code}"${s.code === selected ? " selected" : ""}>${s.name} (${s.code})</option>`)
    .join("");
}

export function stateName(states, code) {
  const state = states.find((s) => s.code === code);
  return state ? `${state.name} (${state.code})` : "";
}
