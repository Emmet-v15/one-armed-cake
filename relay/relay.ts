// Public relay for the dashboard's read-only view.
//
// Runs on a server with a public address. The router reaches it through a
// reverse SSH tunnel (see netmon-tunnel.service), which exposes the dashboard's
// public listener on this host's loopback as UPSTREAM. The relay holds ONE
// WebSocket to it and fans that stream out to every viewer, so the router's
// upload cost is the same for one viewer or a hundred. With no viewers it
// disconnects, and the tunnel carries nothing.
//
// The relay only forwards what the read-only listener already sends. It never
// forwards a request body or a non-GET method upstream.
//
//   RELAY_UPSTREAM  http://127.0.0.1:18081   tunnel end of the public listener
//   RELAY_PORT      3091                     listen port (loopback; nginx in front)
//   RELAY_MAX       200                      viewer cap

const UPSTREAM = (process.env.RELAY_UPSTREAM ?? "http://127.0.0.1:18081").replace(/\/$/, "");
const PORT = Number(process.env.RELAY_PORT ?? 3091);
const MAX_VIEWERS = Number(process.env.RELAY_MAX ?? 200);
const IDLE_MS = 30_000;        // keep the upstream open this long after the last viewer leaves
const SEED_TTL_MS = 2_000;     // seed (snapshot + history) is fetched at most this often

let html = "";                 // the page, refreshed from upstream
let htmlAt = 0;
let seed = "";                 // last /api/stats body: snapshot plus history
let seedAt = 0;
let seedPending: Promise<string> | null = null;
let upstream: WebSocket | null = null;
let idleTimer: Timer | null = null;
let retry = 1000;
let lastUpstreamMsg = 0;

async function getText(path: string): Promise<string> {
  const r = await fetch(UPSTREAM + path, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.text();
}

async function page(): Promise<string> {
  if (!html || Date.now() - htmlAt > 60_000) {
    try { html = await getText("/"); htmlAt = Date.now(); } catch (e) { if (!html) throw e; }
  }
  return html;
}

// New viewers need history for the chart. Coalesce bursts of joins into one
// upstream fetch, and reuse it for a couple of seconds.
function getSeed(): Promise<string> {
  if (seed && Date.now() - seedAt < SEED_TTL_MS) return Promise.resolve(seed);
  seedPending ??= getText("/api/stats")
    .then((t) => { seed = t; seedAt = Date.now(); return t; })
    .finally(() => { seedPending = null; });
  return seedPending;
}

function connectUpstream() {
  if (upstream || server.subscriberCount("stats") === 0) return;
  const ws = new WebSocket(UPSTREAM.replace(/^http/, "ws") + "/ws");
  upstream = ws;
  ws.onopen = () => { retry = 1000; lastUpstreamMsg = Date.now(); };
  ws.onmessage = (ev) => {
    lastUpstreamMsg = Date.now();
    server.publish("stats", String(ev.data));
  };
  ws.onclose = () => {
    if (upstream === ws) upstream = null;
    if (server.subscriberCount("stats") > 0) {
      setTimeout(connectUpstream, retry);
      retry = Math.min(retry * 2, 30_000);
    }
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// A tunnel that dies silently leaves an open socket that never delivers.
setInterval(() => {
  if (upstream && upstream.readyState === WebSocket.OPEN && Date.now() - lastUpstreamMsg > 10_000) {
    try { upstream.close(); } catch {}
  }
}, 5_000);

function viewerLeft() {
  if (server.subscriberCount("stats") > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (server.subscriberCount("stats") === 0 && upstream) { const u = upstream; upstream = null; u.close(); }
  }, IDLE_MS);
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  development: false,
  async fetch(req, srv) {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405 });
    const url = new URL(req.url);
    try {
      if (url.pathname === "/ws") {
        if (server.subscriberCount("stats") >= MAX_VIEWERS) return new Response("too many viewers", { status: 503 });
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/api/stats") {
        return new Response(await getSeed(), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (url.pathname === "/") {
        return new Response(await page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      return new Response("not found", { status: 404 });
    } catch {
      return new Response("The home network is not reachable right now.", { status: 502 });
    }
  },
  websocket: {
    perMessageDeflate: true,     // viewers' bandwidth is the server's, not the home line's
    async open(ws) {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      try { ws.send(await getSeed()); } catch {}
      ws.subscribe("stats");
      connectUpstream();
    },
    close(ws) { ws.unsubscribe("stats"); viewerLeft(); },
    message() {},
  },
});

console.log(`relay on 127.0.0.1:${PORT} -> ${UPSTREAM} (max ${MAX_VIEWERS} viewers)`);
