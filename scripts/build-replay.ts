/**
 * Builds the no-login replay page from a verified live run: one self-contained HTML file with the
 * run's events inlined (no server, no keys). Each event is tagged with the demo scene it belongs to
 * by walking the run's log, which prints every event under its scene heading in order.
 *   npx tsx scripts/build-replay.ts [deskFile] [logFile] [artifactOut]
 * Writes docs/index.html (GitHub Pages) and, when artifactOut is given, the same page without the
 * document wrapper for publishing as an Artifact.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeskState } from "../src/desk/desk.js";

const [deskFile = "data/desk-demo.json", logFile = "data/logs/demo-run-vic2.log", artifactOut] = process.argv.slice(2);
const state = JSON.parse(readFileSync(deskFile, "utf8")) as DeskState;
const log = readFileSync(logFile, "utf8").split("\n");

const run = log.map((l) => /demo run (\S+) complete/.exec(l)?.[1]).find(Boolean);
if (!run) throw new Error(`no completed run in ${logFile}`);

// Walk the log: a "■ key · title" line opens a scene; each "[buyer/type] summary" line is the next event.
const scenes: { key: string; title: string; firstSeq: number | null }[] = [];
const sceneOf = new Map<number, string>();
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

const data = {
  run,
  ranAt: state.events[0]?.at ?? "",
  buyers: Object.values(state.buyers).map((b) => ({ id: b.id, name: b.name, account: b.account })),
  scenes: scenes.filter((s) => s.firstSeq !== null),
  events: state.events.map((e) => ({ ...e, scene: sceneOf.get(e.seq) })),
};
const json = JSON.stringify(data).replace(/</g, "\\u003c");

const page = readFileSync("src/replay/replay.html", "utf8").replace("/*RUN_DATA*/{}", () => json);
if (page.includes("/*RUN_DATA*/")) throw new Error("template placeholder not replaced");

// The template's <title>, metas and <style> come before the HEAD-END marker: they go in <head>.
const [head, body] = page.split("<!--HEAD-END-->");
if (head === undefined || body === undefined) throw new Error("template has no <!--HEAD-END--> marker");
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head.trim()}\n</head>\n<body>\n${body.trim()}\n</body>\n</html>\n`;
writeFileSync("docs/index.html", full);
if (artifactOut) {
  mkdirSync(dirname(artifactOut), { recursive: true });
  writeFileSync(artifactOut, page);
}
console.log(`replay of run ${run}: ${data.events.length} events in ${data.scenes.length} scenes → docs/index.html${artifactOut ? ` and ${artifactOut}` : ""} (${(full.length / 1024).toFixed(0)} KB)`);
