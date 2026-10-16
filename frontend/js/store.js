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
  const brand = document.getElementById("brand-business");
  if (brand) brand.textContent = settings.business_name || "GST Invoicing";
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
