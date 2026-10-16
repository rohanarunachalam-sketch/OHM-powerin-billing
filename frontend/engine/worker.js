// Web worker that hosts the Python backend (Pyodide). It never touches the page; it only answers requests.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
importScripts(PYODIDE + "pyodide.js");

let handle = null;
let py = null;
let queue = Promise.resolve();
let syncTimer = null;

const progress = (text) => postMessage({ type: "progress", text });

function persist() {
  // Debounced: copy the in-memory /data folder (database, logos, PDFs) into the browser's IndexedDB.
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => py.FS.syncfs(false, (error) => error && console.error("persist failed", error)), 600);
}

async function init() {
  progress("Starting Python…");
  py = await loadPyodide({ indexURL: PYODIDE });
  progress("Loading database and libraries…");
  await py.loadPackage(["micropip", "sqlalchemy", "pydantic", "pillow", "sqlite3", "anyio"]);
  progress("Installing FastAPI, ReportLab and Excel support…");
  const micropip = py.pyimport("micropip");
  // Pinned to releases that work with the Python libraries bundled in Pyodide (pydantic 2.10, SQLAlchemy 2.0).
  await micropip.install(["fastapi==0.115.6", "starlette==0.41.3", "reportlab==4.2.5", "openpyxl==3.1.5", "python-multipart==0.0.20"]);

  progress("Opening your saved data…");
  py.FS.mkdir("/data");
  py.FS.mount(py.FS.filesystems.IDBFS, {}, "/data");
  await new Promise((resolve, reject) => py.FS.syncfs(true, (error) => (error ? reject(error) : resolve())));

  progress("Loading the billing application…");
  const archive = await (await fetch(new URL("app.zip", self.location.href))).arrayBuffer();
  py.unpackArchive(archive, "zip", { extractDir: "/app" });
  await py.runPythonAsync("import sys\nif '/app' not in sys.path: sys.path.insert(0, '/app')\nimport shim");
  handle = py.pyimport("shim").handle;
  persist();
}

async function run(message) {
  const body = message.body ? new Uint8Array(message.body) : null;
  const result = await handle(message.method, message.path, JSON.stringify(message.headers || {}), body);
  const [status, headers, payload] = result.toJs();
  result.destroy?.();
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const copy = bytes.slice(); // detach from the Python heap
  if (message.method !== "GET" && message.method !== "HEAD") persist();
  postMessage({ type: "response", id: message.id, status, headers: JSON.parse(headers), body: copy.buffer }, [copy.buffer]);
}

onmessage = (event) => {
  const message = event.data;
  if (message.type === "init") {
    init().then(
      () => postMessage({ type: "ready" }),
      (error) => postMessage({ type: "failed", text: String(error && error.message ? error.message : error) }),
    );
  } else if (message.type === "request") {
    // One request at a time: the backend is single-threaded and uses a single SQLite database.
    queue = queue.then(() => run(message)).catch((error) =>
      postMessage({ type: "response", id: message.id, status: 500, headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode(JSON.stringify({ detail: "Something went wrong. Please try again." })).buffer }));
  }
};
