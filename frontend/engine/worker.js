// Web worker that hosts the Python backend (Pyodide). It never touches the page; it only answers requests.
// Everything (Python runtime, libraries, wheels) is served from this site: no third-party CDN or PyPI needed.
const HERE = new URL("./", self.location.href).href;
const PYODIDE = HERE + "pyodide/";
importScripts(PYODIDE + "pyodide.js");

// Pinned releases that work with the libraries bundled in Pyodide (pydantic 2.10, SQLAlchemy 2.0).
const WHEELS = [
  "chardet-5.2.0-py3-none-any.whl", "et_xmlfile-2.0.0-py3-none-any.whl", "openpyxl-3.1.5-py2.py3-none-any.whl",
  "python_multipart-0.0.20-py3-none-any.whl", "reportlab-4.2.5-py3-none-any.whl", "starlette-0.41.3-py3-none-any.whl",
  "fastapi-0.115.6-py3-none-any.whl",
].map((name) => HERE + "wheels/" + name);

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
  await micropip.install(WHEELS, { deps: false });

  progress("Opening your saved data…");
  py.FS.mkdir("/data");
  py.FS.mount(py.FS.filesystems.IDBFS, {}, "/data");
  await new Promise((resolve, reject) => py.FS.syncfs(true, (error) => (error ? reject(error) : resolve())));

  progress("Loading the billing application…");
  const archive = await (await fetch(HERE + "app.zip", { cache: "no-cache" })).arrayBuffer();
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
