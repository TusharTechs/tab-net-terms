/**
 * The full TAB story, live, written to one desk log the demo screen streams.
 *   npx tsx scripts/demo-run.ts            (PACE=ms between beats, default 2500)
 *
 * Live: Metal testnet (mandates, pulls), Claude (dispute reading), Airwallex sandbox
 * (deposit simulation → FX quote → conversion). Acme's Visa VIC payment is the real one
 * paid on 2026-11-09 (scripts/vic-statement.ts). Books are the labelled stand-in until T:0 works.
 */
import { existsSync, renameSync } from "node:fs";
import { AirwallexClient } from "../src/airwallex/client.js";
import { StandinBooks } from "../src/books/books.js";
import { claude } from "../src/claude/client.js";
import { config } from "../src/config.js";
import { Desk, type DeskState, fileStore } from "../src/desk/desk.js";
import { decideDispute } from "../src/disputes/decide.js";
import { readDispute } from "../src/disputes/reader.js";
import { FileLedger } from "../src/ledger/settlements.js";
import { MetalAgent, usdzBalance } from "../src/metal/agent.js";
import { settleCollection } from "../src/settlement/bridge.js";

const cfg = config();
if (!cfg.METAL_RPC_URL) throw new Error("METAL_RPC_URL missing");
const PACE = Number(process.env.PACE ?? 2500);
const pause = () => new Promise((r) => setTimeout(r, PACE));
const run = `d${Date.now().toString(36)}`;

const SUPPLIER = "0x6C7578104c945e6A0b21eD9f022abE197a40B6B4";
const ISSUER = { key: "keys/supplier-issuer.json", pub: "keys/supplier-issuer.public.json" };
const ACME = { account: "0x4d0a5161AbA00FB71397675a1919163d6e7cEd33", owner: "keys/buyer-owner.json" };
const GLOBEX_OWNER = "keys/globex-owner.json";
const USD_GLOBAL_ACCOUNT = "7d7f991a-1360-4b31-9437-fa2167a9ab96";

const DESK_FILE = "data/desk-demo.json";
if (existsSync(DESK_FILE)) renameSync(DESK_FILE, `data/desk-demo.${Date.now()}.bak.json`);
const store = fileStore(DESK_FILE);
const state: DeskState = { buyers: {}, events: [] };
const books = new StandinBooks("fixtures/standin-books.json");
const metal = new MetalAgent();
const desk = new Desk(state, { supplierPayee: SUPPLIER, metal, balanceOf: (a) => usdzBalance(cfg.METAL_RPC_URL!, a), books, now: () => new Date(), persist: store.save });
const awx = new AirwallexClient({ baseUrl: cfg.AWX_BASE_URL, clientId: cfg.AWX_CLIENT_ID, apiKey: cfg.AWX_API_KEY });

const say = (s: string) => console.log(`\n■ ${s}`);
let mark = 0;
const tail = () => {
  state.events.slice(mark).forEach((e) => console.log(`  [${e.buyerId}/${e.type}] ${e.summary}${e.data.tx ? `  tx ${e.data.tx}` : ""}`));
  mark = state.events.length;
};

async function bindMandate(buyerId: string, principal: string, ownerKey: string, budget: number, replaces?: { credential: string; mandateKeyFile: string }) {
  const out = `keys/${buyerId}-${run}-${replaces ? "v2" : "v1"}.json`;
  const issued = await metal.issueCredential({ principal, cap: 5_000, budget, payee: SUPPLIER, payeeLabel: "Northwind Data", issuerKey: ISSUER.key, out, description: `TAB debit mandate ${buyerId} ${run}`, ...(replaces ? { mandateKeyFile: replaces.mandateKeyFile } : {}) });
  const bound = await metal.bind({ credential: out, ownerKey, issuerPublic: ISSUER.pub, ...(replaces ? { replaces: replaces.credential } : {}) });
  desk.recordMandate(buyerId, { credential: out, mandateKeyFile: issued.mandateKeyFile, mandateId: issued.mandateId, tx: bound.tx, budget, replaced: Boolean(replaces) });
}

// ── Setup: buyers known to the desk ─────────────────────────────────────────────
state.buyers = {
  acme: { id: "acme", name: "Acme procurement agent", account: ACME.account, vicSettledCount: 0, orders: [] },
} as DeskState["buyers"];
// Each run collects from Acme, so top its testnet account back up (the faucet fills to 100 USDZ).
if ((await usdzBalance(cfg.METAL_RPC_URL!, ACME.account)) < 9_000) await metal.fund(ACME.account);
let globexAccount: string;
{
  const existing = existsSync(GLOBEX_OWNER);
  const acct = await metal.createAccount(GLOBEX_OWNER, existing);
  globexAccount = acct.account;
  if ((await usdzBalance(cfg.METAL_RPC_URL!, globexAccount)) < 5_000) await metal.fund(globexAccount);
  state.buyers.globex = { id: "globex", name: "Globex sourcing agent", account: globexAccount, vicSettledCount: 0, orders: [] };
}
store.save(state);

// ── Scene 1: Acme's Visa-verified payment is its on-ramp to credit ─────────────────
say("Scene 1 · Acme paid its first statement with a passkey-approved Visa credential");
desk.recordVicPayment("acme", { paymentIntentId: "int_sgpvtdh4nhnzlj965wb", mandateId: "mdt_sgpdvzqsghnzlj9vq2w", amount: 18_600, statementId: "STM-20261109-E5DP" });
tail();
await pause();

// ── Scene 2: Acme's human binds a debit mandate → net-30; agent orders go on the tab ─
say("Scene 2 · Acme's human binds a $90 debit mandate; its agent orders on net-30");
await bindMandate("acme", ACME.account, ACME.owner, 9_000);
await desk.evaluate("acme");
tail();
await pause();
const orders = [
  { id: `${run}-o1`, amount: 600, description: "Market data · 150 queries", priceRoute: "/v2/query", unitPrice: 4, units: 150, staleUnits: 15 },
  { id: `${run}-o2`, amount: 700, description: "FX tick backfill · 175 rows", priceRoute: "/v2/query", unitPrice: 4, units: 175, staleUnits: 0 },
  { id: `${run}-o3`, amount: 500, description: "Priority SLA · 1 day", priceRoute: "/v2/sla", unitPrice: 500, units: 1, staleUnits: 0 },
];
for (const o of orders) {
  await desk.placeOrder("acme", o);
  tail();
  await pause();
}

// ── Scene 3: Globex asks for terms; the books say no ─────────────────────────────
say("Scene 3 · Globex binds a mandate, but its books show an invoice 22 days overdue");
await bindMandate("globex", globexAccount, GLOBEX_OWNER, 3_000);
desk.recordBooks("globex", "books: INV-2002 ($400.00) due Oct 18, unpaid", { invoice: "INV-2002", source: books.source });
await desk.evaluate("globex");
await desk.placeOrder("globex", { id: `${run}-g1`, amount: 4_000, description: "Bulk vendor data", priceRoute: "/v2/query", unitPrice: 4, units: 1_000, staleUnits: 0 });
tail();
await pause();

// ── Scene 4: Acme disputes; the model reads, code decides ───────────────────────
say("Scene 4 · Acme disputes the price and the data quality");
const email = `Hi Northwind,\n\nOur procurement agent never agreed to 4 cents a query, our contract says 2 cents. And the market data from order ${orders[0]!.id} was stale: all 150 rows had yesterday's prices. Please refund it.\n\nPriya, Finance, Acme`;
const target = claude();
const read = await readDispute(target.client as any, target.model, email, state.buyers.acme!.orders.map((o) => ({ id: o.id, description: o.description, priceRoute: `${o.priceRoute} (${o.unitPrice}¢ per unit)`, units: o.units ?? 1, placedAt: o.placedAt })), target.requestExtras);
desk.resolveDispute("acme", decideDispute(read.claims, desk.evidenceFor("acme")), { summary: read.summary, model: read.model });
tail();
await pause();

// ── Scene 5: Acme's human cuts the mandate; the desk collects before it's gone ───
say("Scene 5 · Acme's human cuts the mandate to $25; the desk collects the tab");
const acme = state.buyers.acme!;
await bindMandate("acme", ACME.account, ACME.owner, 2_500, { credential: acme.credential!, mandateKeyFile: acme.mandateKeyFile! });
await desk.evaluate("acme");
tail();
await pause();

// ── Scene 6: the collection lands in Airwallex and becomes SGD ──────────────────
say("Scene 6 · Settle the collection into Airwallex and convert to SGD");
const collect = [...state.events].reverse().find((e) => e.buyerId === "acme" && e.type === "collect" && e.data.tx);
if (collect) {
  const out = await settleCollection(awx, new FileLedger("data/settlements.json"), USD_GLOBAL_ACCOUNT, { metalTxHash: String(collect.data.tx), amount: Number(collect.data.amount), payerName: "Acme procurement agent" }, async () => false);
  if (out.kind === "converted") {
    desk.recordSettlement("acme", `deposited $${(Number(collect.data.amount) / 100).toFixed(2)} into Airwallex, kept $${(out.reserved / 100).toFixed(2)} refund reserve, converted ${out.quote.sell_amount} USD → ${out.quote.buy_amount} SGD`, { depositId: out.depositId, quoteId: out.quote.quote_id, conversionId: out.conversionId, rate: out.quote.client_rate, metalTx: collect.data.tx });
  } else {
    desk.recordSettlement("acme", `settlement: ${out.kind}${"reason" in out ? ` (${out.reason})` : ""}`, { ...out } as any);
  }
}
tail();
console.log(`\n✔ demo run ${run} complete · ${state.events.length} events in ${DESK_FILE}`);
