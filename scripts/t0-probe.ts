/**
 * Read-only look at the T:0 sandbox: entities, record types, and the real field names of a few
 * invoices / customers / payments. Writes the raw samples to data/t0-sample.json (git-ignored).
 *   npx tsx scripts/t0-probe.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { T0Mcp } from "../src/books/books.js";
import { config } from "../src/config.js";

const cfg = config();
if (!cfg.T0_API_KEY) throw new Error("T0_API_KEY missing in .env");
const t0 = new T0Mcp(cfg.T0_API_KEY);

const shape = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x && typeof x === "object" ? shape(x) : typeof x]));
  return typeof v;
};
const rows = (r: any): any[] => (Array.isArray(r) ? r : r?.data ?? r?.items ?? r?.results ?? r?.records ?? []);

const out: Record<string, unknown> = {};
const step = async (name: string, fn: () => Promise<unknown>) => {
  try {
    const r = await fn();
    out[name] = r;
    const list = rows(r);
    console.log(`✔ ${name}: ${Array.isArray(r) || list.length ? `${list.length} row(s)` : "ok"}`);
    if (list[0]) console.log(`  fields: ${JSON.stringify(shape(list[0]))}`);
    else console.log(`  ${JSON.stringify(shape(r)).slice(0, 400)}`);
  } catch (e) {
    console.log(`✘ ${name}: ${String(e).slice(0, 300)}`);
  }
};

await step("entities", () => t0.call("list_the_entities_you_can_access"));
await step("record_types", () => t0.call("discover_the_exposed_record_types"));
await step("invoices", () => t0.call("list_invoices", { limit: 5 }));
await step("customers", () => t0.call("list_customers", { limit: 5 }));
await step("payments", () => t0.call("list_payments", { limit: 5 }));

mkdirSync("data", { recursive: true });
writeFileSync("data/t0-sample.json", JSON.stringify(out, null, 2));
console.log("\nsamples saved to data/t0-sample.json");
