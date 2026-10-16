// Start-up: use the real backend when there is one (uvicorn); otherwise run the Python backend in the browser
// (GitHub Pages edition) and answer api/* requests through the service worker.
const splash = document.getElementById("engine-splash");
const statusEl = document.getElementById("engine-status");
const errorEl = document.getElementById("engine-error");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stepText = "Starting…";
let stepSince = Date.now();
const startedAt = Date.now();
const setStatus = (text) => { stepText = text; stepSince = Date.now(); render(); };
const render = () => { if (statusEl) statusEl.textContent = `${stepText}  (${Math.round((Date.now() - startedAt) / 1000)}s)`; };
setInterval(render, 1000);
const STALL_MS = 150000;  // no progress for this long: show a clear error instead of loading forever

let worker = null;
let engineReady = false;
let nextId = 1;
const pending = new Map();

// Answer the service worker. Until the engine is up, reply "null" so it never waits on this page.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === "engine-ping") { event.ports[0].postMessage(engineReady); return; }
    if (message.type !== "engine-request") return;
    const port = event.ports[0];
    if (!engineReady) { port.postMessage(null); return; }
    const id = nextId++;
    pending.set(id, (reply) => port.postMessage(reply, [reply.body]));
    worker.postMessage({ type: "request", id, method: message.method, path: message.path, headers: message.headers, body: message.body },
      message.body ? [message.body] : []);
  });
}

async function realBackend() {
  try {
    const response = await fetch("api/health", { cache: "no-store" });
    return response.ok && (await response.json()).status === "ok";
  } catch {
    return false;
  }
}

async function startEngine() {
  if (!("serviceWorker" in navigator) || !window.Worker) {
    throw new Error("This browser cannot run the in-browser edition. Please use a current version of Chrome, Edge, Firefox or Safari.");
  }
  splash.hidden = false;
  setStatus("Preparing…");
  const registration = await navigator.serviceWorker.register("sw.js");
  await Promise.race([navigator.serviceWorker.ready, sleep(20000)]);
  if (!registration.active) {
    throw new Error("The browser did not start the background worker this app needs. Private/incognito windows in some browsers block it: open the site in a normal window.");
  }
  if (!navigator.serviceWorker.controller) {
    await Promise.race([new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })), sleep(4000)]);
  }
  if (!navigator.serviceWorker.controller) {  // e.g. a hard refresh bypassed the worker: one reload fixes it
    if (!sessionStorage.getItem("engine-reloaded")) {
      sessionStorage.setItem("engine-reloaded", "1");
      location.reload();
      await new Promise(() => {});
    }
    throw new Error("The service worker could not take control of this page. Reload the page and try again.");
  }
  sessionStorage.removeItem("engine-reloaded");

  worker = new Worker(new URL("worker.js", import.meta.url));
  await new Promise((resolve, reject) => {
    const watchdog = setInterval(() => {
      if (Date.now() - stepSince > STALL_MS) {
        clearInterval(watchdog);
        reject(new Error(`Start-up stalled at "${stepText}". Check your internet connection, disable content blockers for this site, and try again.`));
      }
    }, 5000);
    const done = (fn) => (value) => { clearInterval(watchdog); fn(value); };
    resolve = done(resolve); reject = done(reject);
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "progress") setStatus(message.text);
      else if (message.type === "ready") resolve();
      else if (message.type === "failed") reject(new Error(message.text));
      else if (message.type === "response") {
        const done = pending.get(message.id);
        pending.delete(message.id);
        done?.({ status: message.status, headers: message.headers, body: message.body });
      }
    };
    worker.onerror = (event) => reject(new Error(event.message || "The billing engine crashed."));
    worker.postMessage({ type: "init" });
  });
  engineReady = true;
  splash.hidden = true;
  interceptDownloads();
}

/**
 * Links to api/* (PDF, Excel export) are fetched by the page and saved from memory: browsers do not reliably treat a
 * service-worker response as a download or as a printable PDF tab.
 */
function interceptDownloads() {
  document.addEventListener("click", async (event) => {
    const link = event.target.closest('a[href^="api/"]');
    if (!link || event.defaultPrevented) return;
    event.preventDefault();
    const wantsDownload = link.hasAttribute("download");
    const tab = wantsDownload ? null : window.open("", "_blank");  // opened synchronously so it is not popup-blocked
    try {
      const response = await fetch(link.getAttribute("href"));
      if (!response.ok) throw new Error("Request failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      if (tab) {
        tab.location.href = url;
      } else {
        const match = /filename="?([^";]+)"?/i.exec(response.headers.get("content-disposition") || "");
        const saver = document.createElement("a");
        saver.href = url;
        saver.download = match ? match[1] : "download";
        document.body.appendChild(saver);
        saver.click();
        saver.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (error) {
      tab?.close();
      console.error(error);
      (await import("../js/ui.js")).toast("The file could not be created", "error", "Please try again.");
    }
  });
}

try {
  if (!(await realBackend())) await startEngine();
  await import("../app.js");
} catch (error) {
  console.error(error);
  if (splash) {
    splash.hidden = false;
    document.querySelector(".splash-bar")?.setAttribute("hidden", "");
    setStatus("The application could not start.");
    if (errorEl) { errorEl.textContent = error.message || String(error); errorEl.hidden = false; }
    document.getElementById("engine-retry")?.removeAttribute("hidden");
  }
}
