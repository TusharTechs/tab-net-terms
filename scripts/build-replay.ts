/**
 * Builds the no-login replay page from a verified live run: the same app as the live screen
 * (public/index.html + brand.css + app.js), with the run's events inlined, in one self-contained
 * HTML file (no server, no keys).
 *   npx tsx scripts/build-replay.ts [deskFile] [logFile] [artifactOut]
 * Scenes come from the run's own "scene" events; for older runs without them, each event is tagged
 * by walking the run's log, which prints every event under its scene heading in order.
 * Writes docs/index.html (GitHub Pages) and, when artifactOut is given, the same page without the
 * document wrapper for publishing as an Artifact.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeskState } from "../src/desk/desk.js";

const [deskFile = "data/desk-demo.json", logFile, artifactOut] = process.argv.slice(2);
const state = JSON.parse(readFileSync(deskFile, "utf8")) as DeskState;
const log = logFile && existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n") : [];
const sceneEvents = state.events.filter((e) => e.type === "scene");

const run =
  log.map((l) => /demo run (\S+) complete/.exec(l)?.[1]).find(Boolean) ??
  (sceneEvents[0]?.data.run as string | undefined);
if (!run) throw new Error("no run id: pass the run's log, or use a run that records scene events");

const scenes: { key: string; title: string; firstSeq: number | null }[] = [];
const sceneOf = new Map<number, string>();
if (!sceneEvents.length) {
  if (!log.length) throw new Error("this run has no scene events: pass its log file");
  // Walk the log: a "■ key · title" line opens a scene; each "[buyer/type] summary" line is the next event.
  let next = 0;
  for (const line of log) {
    const head = /^■ (\S+) · (.+)$/.exec(line);
    if (head) {
      scenes.push({ key: head[1]!, title: head[2]!, firstSeq: null });
      continue;
    }
    const ev = /^ {2}\[([^/\]]+)\/([^\]]+)\] (.*)$/.exec(line);
    if (!ev || !scenes.length) continue;
    const e = state.events[next];
    if (!e || e.buyerId !== ev[1] || e.type !== ev[2] || !ev[3]!.startsWith(e.summary.slice(0, 40))) {
      throw new Error(`log and desk file disagree at event ${next}: log says [${ev[1]}/${ev[2]}] "${ev[3]!.slice(0, 50)}", desk has [${e?.buyerId}/${e?.type}] "${e?.summary.slice(0, 50)}"`);
    }
    const scene = scenes.at(-1)!;
    scene.firstSeq ??= e.seq;
    sceneOf.set(e.seq, scene.key);
    next++;
  }
  if (next !== state.events.length) throw new Error(`log covers ${next} of ${state.events.length} events`);
}

const data = {
  run,
  ranAt: state.events[0]?.at ?? "",
  // Only who the buyers are: never credential or key file paths.
  buyers: Object.values(state.buyers).map((b) => ({ id: b.id, name: b.name, account: b.account })),
  scenes: scenes.filter((s) => s.firstSeq !== null),
  events: state.events.map((e) => (sceneOf.has(e.seq) ? { ...e, scene: sceneOf.get(e.seq) } : e)),
};
const json = JSON.stringify(data).replace(/</g, "\\u003c");

// One page for live and replay: inline its stylesheet, script, favicon and the run.
const swap = (s: string, from: string, to: string) => {
  if (!s.includes(from)) throw new Error(`template is missing ${from}`);
  return s.replace(from, () => to);
};
let page = readFileSync("public/index.html", "utf8");
page = swap(page, '<link rel="stylesheet" href="brand.css">', `<style>\n${readFileSync("public/brand.css", "utf8")}\n</style>`);
page = swap(page, '<script src="app.js"></script>', `<script>\n${readFileSync("public/app.js", "utf8").replace(/<\/script/gi, "<\\/script")}\n</script>`);
page = swap(page, "<!--RUN-->", `<script>window.__RUN__ = ${json};</script>`);
page = swap(page, 'href="logo.svg"', `href="data:image/svg+xml,${encodeURIComponent(readFileSync("public/logo.svg", "utf8"))}"`);
page = swap(page, "<title>TAB Desk</title>", "<title>TAB Desk Replay</title>");
writeFileSync("docs/index.html", page);

if (artifactOut) {
  // The artifact host supplies the document, charset and viewport: keep the rest of <head>, then <body>.
  const head = /<head>([\s\S]*?)<\/head>/.exec(page)![1]!.replace(/<meta charset[^>]*>\s*/, "").replace(/<meta name="viewport"[^>]*>\s*/, "");
  const body = /<body>([\s\S]*?)<\/body>/.exec(page)![1]!;
  mkdirSync(dirname(artifactOut), { recursive: true });
  writeFileSync(artifactOut, `${head.trim()}\n${body.trim()}\n`);
}
console.log(`replay of run ${run}: ${data.events.length} events in ${sceneEvents.length || data.scenes.length} scenes → docs/index.html${artifactOut ? ` and ${artifactOut}` : ""} (${(page.length / 1024).toFixed(0)} KB)`);
