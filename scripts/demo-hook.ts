/**
 * Live hook scenario on Metal testnet (real chain; books are the labelled stand-in until T:0 works):
 *   1. supplier issues a debit mandate (budget 9.00) to Acme; Acme's owner binds it
 *   2. Acme's agent places three orders → on the tab
 *   3. Acme's human cuts the mandate to 2.50 (supplier issues the replacement, owner replaces)
 *   4. desk re-evaluates → limit tightened → collects exactly those orders with one pull
 *   5. a further order no longer fits → prepay
 * Prints the desk's event log. State in data/desk-hook.json.
 */
import { StandinBooks } from "../src/books/books.js";
import { config } from "../src/config.js";
import { Desk, fileStore } from "../src/desk/desk.js";
import { MetalAgent, usdzBalance } from "../src/metal/agent.js";

const cfg = config();
if (!cfg.METAL_RPC_URL) throw new Error("METAL_RPC_URL missing");
const SUPPLIER = "0x6C7578104c945e6A0b21eD9f022abE197a40B6B4";
const ACME = "0x4d0a5161AbA00FB71397675a1919163d6e7cEd33";
const run = `r${Date.now().toString(36)}`;
const cred = (v: string) => `keys/acme-${run}-${v}.json`;

const metal = new MetalAgent();
const store = fileStore("data/desk-hook.json");
const state = { buyers: {}, events: [] } as ReturnType<typeof store.load>;
const desk = new Desk(state, {
  supplierPayee: SUPPLIER,
  metal,
  balanceOf: (a) => usdzBalance(cfg.METAL_RPC_URL!, a),
  books: new StandinBooks("fixtures/standin-books.json"),
  now: () => new Date(),
  persist: store.save,
});
const log = (s: string) => console.log(`\n▶ ${s}`);
const tail = (from: number) => state.events.slice(from).forEach((e) => console.log(`  [${e.type}] ${e.summary}${e.data.tx ? `  tx ${e.data.tx}` : ""}`));

log("supplier issues mandate (budget 9.00, cap 5.00) to Acme; Acme's owner binds it");
const v1 = await metal.issueCredential({ principal: ACME, cap: 500, budget: 900, payee: SUPPLIER, payeeLabel: "Northwind Data", issuerKey: "keys/supplier-issuer.json", out: cred("v1"), description: `TAB tab for Acme ${run}` });
const bind1 = await metal.bind({ credential: cred("v1"), ownerKey: "keys/buyer-owner.json", issuerPublic: "keys/supplier-issuer.public.json" });
console.log(`  mandate ${v1.mandateId}  bind tx ${bind1.tx}`);
state.buyers = { acme: { id: "acme", name: "Acme procurement agent", account: ACME, credential: cred("v1"), mandateKeyFile: v1.mandateKeyFile, vicSettledCount: 1, orders: [] } } as any;

log("Acme's agent places three orders");
let mark = state.events.length;
for (const [id, amount, d] of [[`${run}-o1`, 60, "market data 1,500 queries"], [`${run}-o2`, 70, "FX tick backfill"], [`${run}-o3`, 50, "priority SLA day"]] as const) {
  await desk.placeOrder("acme", { id, amount, description: d });
}
tail(mark);

log("Acme's human cuts the mandate budget to 2.50");
const v2 = await metal.issueCredential({ principal: ACME, cap: 500, budget: 250, payee: SUPPLIER, payeeLabel: "Northwind Data", issuerKey: "keys/supplier-issuer.json", out: cred("v2"), description: `TAB tab for Acme ${run} (reduced)`, mandateKeyFile: v1.mandateKeyFile });
const rep = await metal.bind({ credential: cred("v2"), ownerKey: "keys/buyer-owner.json", issuerPublic: "keys/supplier-issuer.public.json", replaces: cred("v1") });
console.log(`  mandate ${v2.mandateId}  replace tx ${rep.tx}`);
state.buyers.acme!.credential = cred("v2");

log("desk re-evaluates");
mark = state.events.length;
await desk.evaluate("acme");
tail(mark);

log("Acme's agent orders 1.00 more");
mark = state.events.length;
await desk.placeOrder("acme", { id: `${run}-o4`, amount: 100, description: "extra queries" });
tail(mark);

const s = await metal.status(cred("v2"));
console.log(`\n✔ mandate now: spent ${s.spent / 100} of ${s.budget / 100} USDZ, revoked ${s.revoked}; events saved to data/desk-hook.json`);
