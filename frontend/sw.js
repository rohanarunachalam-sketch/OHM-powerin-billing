// Service worker for the static (GitHub Pages) edition: requests to api/* are answered by the in-browser backend.
// With a real server (uvicorn) this worker is never registered.
const scopePath = new URL(self.registration.scope).pathname;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(scopePath + "api/")) {
    event.respondWith(forward(event.request, url));
  }
});

function ask(client, message, timeout = 180000) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeout);
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
    client.postMessage(message, [channel.port2]);
  });
}

async function forward(request, url) {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : null;
  const headers = {};
  for (const name of ["content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const message = {
    type: "engine-request", method: request.method, headers, body,
    path: "/" + url.pathname.slice(scopePath.length) + url.search,
  };
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    // Quick check first: tabs that are not running the engine (old tabs, still starting) must never block a request.
    if (!(await ask(client, { type: "engine-ping" }, 1500))) continue;
    const reply = await ask(client, message);
    if (reply) {
      const empty = [204, 205, 304].includes(reply.status);
      // Range/validator headers make no sense for a response built in memory (and can make downloads fail).
      const headers = reply.headers.filter(([name]) => !["accept-ranges", "etag", "last-modified", "content-length"].includes(name.toLowerCase()));
      return new Response(empty ? null : reply.body, { status: reply.status, headers });
    }
  }
  return new Response(JSON.stringify({ detail: "The billing engine is still starting. Please wait a moment and try again." }), {
    status: 503, headers: { "content-type": "application/json" },
  });
}
