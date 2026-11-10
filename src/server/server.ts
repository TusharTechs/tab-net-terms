import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import type { DeskEvent, DeskState } from "../desk/desk.js";
import { type Fault, FAULTS } from "./faults.js";

/**
 * Demo screen server. Serves public/ and streams the desk's event log (a JSON file the
 * desk writes) over Server-Sent Events. Read-only, unless ALLOW_FAULTS=1 turns on the
 * "try to make TAB double-charge" buttons, which send real (refused-by-design) collection
 * attempts to Metal testnet from localhost.
 *   DESK_FILE=data/desk-hook.json PORT=4173 npx tsx src/server/server.ts
 */

const PORT = Number(process.env.PORT ?? 4173);
const DESK_FILE = resolve(process.env.DESK_FILE ?? "data/desk-demo.json");
const PUBLIC = resolve("public");
/** Live fault buttons ("try to make TAB double-charge"): off unless ALLOW_FAULTS=1, localhost only. */
const ALLOW_FAULTS = process.env.ALLOW_FAULTS === "1";
let faultBusy = false;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function readState(): DeskState {
  try {
    return JSON.parse(readFileSync(DESK_FILE, "utf8")) as DeskState;
  } catch {
    return { buyers: {}, events: [] };
  }
}

/** The page derives everything from the event log; it only needs who the buyers are. */
const buyersOf = (state: DeskState) => Object.values(state.buyers).map((b) => ({ id: b.id, name: b.name, account: b.account }));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/state") {
    const s = readState();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ buyers: buyersOf(s), events: s.events, deskFile: DESK_FILE.split("/").slice(-2).join("/"), faults: ALLOW_FAULTS ? FAULTS : null }));
    return;
  }
  if (url.pathname.startsWith("/api/try/") && req.method === "POST") {
    const fault = url.pathname.slice("/api/try/".length) as Fault;
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    const send = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (!ALLOW_FAULTS || !local) return send(403, { ok: false, message: "fault buttons are off (ALLOW_FAULTS=1, localhost only)" });
    if (!Object.hasOwn(FAULTS, fault)) return send(404, { ok: false, message: "unknown fault" });
    if (faultBusy) return send(409, { ok: false, message: "another attempt is still running" });
    faultBusy = true;
    import("./faults.js")
      .then((m) => m.runFault(fault, DESK_FILE))
      .then((r) => send(200, r))
      .catch((e) => send(500, { ok: false, message: e instanceof Error ? e.message : String(e) }))
      .finally(() => { faultBusy = false; });
    return;
  }
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let sent = Number(url.searchParams.get("after") ?? 0);
    const push = () => {
      const s = readState();
      const last = s.events.at(-1)?.seq ?? 0;
      if (last < sent) {
        // The desk file was replaced (a new run started): the page reloads from the top.
        sent = last;
        res.write(`data: ${JSON.stringify({ reset: true })}\n\n`);
        return;
      }
      const fresh = s.events.filter((e: DeskEvent) => e.seq > sent);
      if (fresh.length === 0) return;
      sent = last;
      res.write(`data: ${JSON.stringify({ buyers: buyersOf(s), events: fresh })}\n\n`);
    };
    const timer = setInterval(push, 700);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(timer);
      clearInterval(ping);
    });
    return;
  }
  const file = join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

if (process.argv[1]?.endsWith("server.ts")) {
  server.listen(PORT, () => console.log(`TAB demo screen on http://localhost:${PORT} (desk file ${DESK_FILE})`));
}
