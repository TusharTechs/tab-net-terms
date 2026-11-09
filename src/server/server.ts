import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import type { DeskEvent, DeskState } from "../desk/desk.js";

/**
 * Demo screen server. Serves public/ and streams the desk's event log (a JSON file the
 * desk writes) over Server-Sent Events. Read-only: it never moves money.
 *   DESK_FILE=data/desk-hook.json PORT=4173 npx tsx src/server/server.ts
 */

const PORT = Number(process.env.PORT ?? 4173);
const DESK_FILE = resolve(process.env.DESK_FILE ?? "data/desk-demo.json");
const PUBLIC = resolve("public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function readState(): DeskState {
  try {
    return JSON.parse(readFileSync(DESK_FILE, "utf8")) as DeskState;
  } catch {
    return { buyers: {}, events: [] };
  }
}

/** Per-buyer view the page renders: latest decision, open tab, mandate snapshot. */
export function summarize(state: DeskState) {
  return Object.values(state.buyers).map((b) => {
    const decisions = state.events.filter((e) => e.buyerId === b.id && e.type === "decision");
    const last = decisions.at(-1)?.data as { decision?: any; inputs?: any } | undefined;
    const open = b.orders.filter((o) => o.route === "ON_TAB" && !o.collectedBy);
    return {
      id: b.id,
      name: b.name,
      account: b.account,
      terms: last?.decision?.terms ?? "—",
      limit: last?.decision?.limit ?? 0,
      available: last?.decision?.available ?? 0,
      outstanding: open.reduce((s, o) => s + o.amount - (o.credited ?? 0), 0) - (b.creditBalance ?? 0),
      openOrders: open.length,
      creditBalance: b.creditBalance ?? 0,
      reasons: (last?.decision?.reasons ?? []).map((r: { code: string; detail: string }) => r),
      mandate: last?.inputs?.mandate ?? null,
      balance: last?.inputs?.balance ?? null,
      booksSource: last?.inputs?.booksSource ?? null,
    };
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/state") {
    const s = readState();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ buyers: summarize(s), events: s.events, deskFile: DESK_FILE.split("/").slice(-2).join("/") }));
    return;
  }
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let sent = Number(url.searchParams.get("after") ?? 0);
    const push = () => {
      const s = readState();
      const fresh = s.events.filter((e: DeskEvent) => e.seq > sent);
      if (fresh.length === 0 && sent <= s.events.length) return;
      if (sent > s.events.length) sent = 0; // desk file was reset
      sent = s.events.length;
      res.write(`data: ${JSON.stringify({ buyers: summarize(s), events: fresh })}\n\n`);
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
