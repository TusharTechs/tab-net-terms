/**
 * TAB, the full story, live. Writes data/desk-demo.json, which the demo screen streams.
 *   npx tsx scripts/demo-run.ts                 (PACE=ms between beats, default 2000)
 *   LIVE_VIC=1 npx tsx scripts/demo-run.ts      (Globex's first order is paid by Visa card: needs a passkey approval)
 *
 * Live: Metal testnet, Claude (buyer agents + dispute reading), Airwallex sandbox, T:0 sandbox.
 * Books: every buyer's history is read from the T:0 sandbox (Acme: an existing customer; Initech and
 * Globex: customers written there by scripts/t0-seed-buyers.ts). Labelled: the Airwallex deposit is a simulation (the sandbox can't receive stablecoins);
 * statement due windows are compressed to minutes so the video can show them.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { type BuyerPersona, runBuyerAgent } from "../src/agents/buyer.js";
import { AirwallexClient } from "../src/airwallex/client.js";
import { bookCollection, T0Mcp } from "../src/books/books.js";
import { deskBooks } from "../src/books/desk-books.js";
import { claude } from "../src/claude/client.js";
import { config } from "../src/config.js";
import { batchPaymentId, Desk, type DeskState, dueOn, fileStore, policyChangeText } from "../src/desk/desk.js";
import { AIRI_TEST_CARD, BUYERS, NORTHWIND } from "../src/desk/northwind.js";
import { decideDispute } from "../src/disputes/decide.js";
import { readDispute } from "../src/disputes/reader.js";
import { FileLedger } from "../src/ledger/settlements.js";
import { findTransfer, MetalAgent, txReceipt, USDZ, usdzBalance } from "../src/metal/agent.js";
import { bookPayout, decidePayouts, recordBillPayment, openVendorBills, payoutsOf, payVendorBill, provenSgdOf, quoteSgdCost } from "../src/payout/vendor.js";
import { applyRails, compileGoals, signPolicy } from "../src/policy/policy.js";
import { checkBooks, checkLive } from "../src/proof/checker.js";
import { settleCollection } from "../src/settlement/bridge.js";
import { authoriseCardStatement, captureCard, openCardStatement } from "../src/visa/card-statement.js";

const cfg = config();
if (!cfg.METAL_RPC_URL) throw new Error("METAL_RPC_URL missing");
const PACE = Number(process.env.PACE ?? 2000);
const LIVE_VIC = process.env.LIVE_VIC === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(PACE);
const run = `r${Date.now().toString(36)}`;

const SUPPLIER = NORTHWIND.supplier;
const ISSUER = NORTHWIND.issuer;
const ACME = BUYERS.acme;
const GLOBEX_OWNER = BUYERS.globex.owner;
const USD_GLOBAL_ACCOUNT = NORTHWIND.usdGlobalAccount;

// ── wiring ───────────────────────────────────────────────────────────────────
const DESK_FILE = "data/desk-demo.json";
if (existsSync(DESK_FILE)) renameSync(DESK_FILE, `data/desk-demo.${Date.now()}.bak.json`);
const store = fileStore(DESK_FILE);
const state: DeskState = { buyers: {}, events: [] };
const awx = new AirwallexClient({ baseUrl: cfg.AWX_BASE_URL, clientId: cfg.AWX_CLIENT_ID, apiKey: cfg.AWX_API_KEY });
const t0 = cfg.T0_API_KEY ? new T0Mcp(cfg.T0_API_KEY) : undefined;
// Writes records (bill payments) into T:0; the account key above reads and posts journal entries.
const t0Import = cfg.T0_IMPORT_API_KEY ? new T0Mcp(cfg.T0_IMPORT_API_KEY) : undefined;
const { books, t0Customers } = await deskBooks(t0);
const metal = new MetalAgent();
const desk = new Desk(state, {
  supplierPayee: SUPPLIER,
  refusalKey: NORTHWIND.supplierWalletKey,
  policyPublicKey: NORTHWIND.cfoPolicyKey.pub,
  metal,
  balanceOf: (a) => usdzBalance(cfg.METAL_RPC_URL!, a),
  findTransfer: (p) => findTransfer(cfg.METAL_RPC_URL!, p),
  books,
  now: () => new Date(),
  persist: store.save,
  readPaymentIntent: (id) => awx.get(`/pa/payment_intents/${id}`),
});
const target = claude();

/** Prints the scene heading and records it in the desk log, so the screen and the replay show it too. */
const say = (s: string) => {
  tail(); // print anything still pending under the previous scene first
  console.log(`\n■ ${s}`);
  const m = /^(\S+) · (.+)$/.exec(s);
  if (m) desk.recordScene(m[1]!, m[2]!, run);
  mark = state.events.length; // the scene marker itself is not printed again as an event line
};
let mark = 0;
const tail = () => {
  state.events.slice(mark).forEach((e) => console.log(`  [${e.buyerId}/${e.type}] ${e.summary.length > 260 ? `${e.summary.slice(0, 260)}…` : e.summary}${e.data.tx ? `  tx ${e.data.tx}` : ""}`));
  mark = state.events.length;
};

async function bindLine(buyerId: string, principal: string, ownerKey: string, budget: number, replaces?: { credential: string; mandateKeyFile: string }) {
  const out = `keys/${buyerId}-${run}-line${replaces ? "-v2" : ""}.json`;
  const issued = await metal.issueCredential({ principal, cap: budget, budget, payee: SUPPLIER, payeeLabel: "Northwind Data", issuerKey: ISSUER.key, out, description: `TAB credit line ${buyerId} ${run}`, ...(replaces ? { mandateKeyFile: replaces.mandateKeyFile } : {}) });
  const bound = await metal.bind({ credential: out, ownerKey, issuerPublic: ISSUER.pub, ...(replaces ? { replaces: replaces.credential } : {}) });
  desk.recordMandate(buyerId, { credential: out, mandateKeyFile: issued.mandateKeyFile, mandateId: issued.mandateId, tx: bound.tx, budget, replaced: Boolean(replaces) });
}

// ── personas (real Claude agents; their own rules are enforced in code) ─────────
const ACME_AGENT: BuyerPersona = {
  buyerId: "acme", company: "Acme Corp", agentName: "Acme procurement agent",
  goal: "Refresh our Q4 pricing model: about 2,000 market-data queries, 10,000 rows of FX tick backfill, and one day of priority SLA during the model run.",
  policy: { maxOrder: 25_000, monthlyBudget: 50_000, costOfCapital: 0.12 },
  cashNote: "Cash is comfortable this month; idle cash earns about 4% a year.",
};
const GLOBEX_AGENT: BuyerPersona = {
  buyerId: "globex", company: "Globex Ltd", agentName: "Globex sourcing agent",
  goal: "We're launching a pricing product: buy 5,000 rows of FX tick backfill now, and 2,000 market-data queries if we can pay later.",
  policy: { maxOrder: 20_000, monthlyBudget: 40_000, costOfCapital: 0.45 },
  cashNote: "Cash is tight until our customers pay us: our short-term borrowing costs 45% a year, so paying later is worth a lot to us.",
};

// ── setup ────────────────────────────────────────────────────────────────────
// Below ~$250 Acme's agent runs out of credit and pays part by card (which this run does not charge), and the
// mid-book cap has nothing to collect: stop rather than spend a passkey on a run that can't show the story.
{
  const acmeBalance = await usdzBalance(cfg.METAL_RPC_URL!, ACME.account);
  if (acmeBalance < 25_000 && process.env.FORCE !== "1") throw new Error(`Acme's testnet balance is $${(acmeBalance / 100).toFixed(2)}: top it up to at least $250 with scripts/top-up-buyer.ts (or set FORCE=1)`);
  if (acmeBalance < 40_000) console.log(`! Acme's testnet balance is $${(acmeBalance / 100).toFixed(2)}: its credit limit will be capped by its balance`);
}
const globexAcct = await metal.createAccount(GLOBEX_OWNER, existsSync(GLOBEX_OWNER));
if ((await usdzBalance(cfg.METAL_RPC_URL!, globexAcct.account)) < 9_000) await metal.fund(globexAcct.account);
state.buyers = {
  acme: { id: "acme", name: "Acme procurement agent", account: ACME.account, vicSettledCount: 0, orders: [] },
  globex: { id: "globex", name: "Globex sourcing agent", account: globexAcct.account, vicSettledCount: 0, orders: [] },
  initech: { id: "initech", name: "Initech buying agent", account: "0x0000000000000000000000000000000000000001", vicSettledCount: 0, orders: [] },
} as DeskState["buyers"];
store.save(state);

/** What the books say about a buyer, and where they say it (T:0, or the labelled stand-in). */
async function showBooks(buyerId: string) {
  const hist = await books.invoicesFor(buyerId);
  const source = books.sourceFor?.(buyerId) ?? books.source;
  const onTime = hist.filter((i) => i.paidAt && i.paidAt.getTime() <= i.dueDate.getTime() + 3 * 864e5).length;
  const overdue = hist.filter((i) => !i.paidAt && i.dueDate.getTime() < Date.now()).length;
  const customer = t0Customers[buyerId];
  const name = t0 && customer ? (await t0.call<{ data?: { name?: string } }>("get_one_customer", { external_id: customer })).data?.name : undefined;
  const where = source === "t0" ? (customer ? `T:0 customer "${name ?? customer}"` : "T:0 holds no transactions for it") : "stand-in books";
  const what = hist.length ? `${onTime} of ${hist.length} invoices paid on time${overdue ? `, ${overdue} overdue` : ""}` : "no invoices with Northwind";
  desk.recordBooks(buyerId, `books (${source === "t0" ? "T:0" : "stand-in"}): ${what} · ${where}`, { source, ...(customer ? { customer } : {}) });
}

// ── 1. Acme: verified Visa payment, credit line, T:0 history → net-30 ────────────
say("1 · Acme: its earlier Visa payment is verified against Airwallex; its human binds a $400 credit line");
const vicPrior = JSON.parse(readFileSync("data/vic/STM-20261109-E5DP.json", "utf8")) as { hash: string; mandateId: string; paymentIntentId: string; statementId: string };
await desk.verifyVicPayment("acme", { paymentIntentId: vicPrior.paymentIntentId, airiMandateId: vicPrior.mandateId, statementId: vicPrior.statementId, statementHash: vicPrior.hash });
await showBooks("acme");
await bindLine("acme", ACME.account, ACME.owner, 40_000);
await desk.evaluate("acme");
tail();
await pause();

// ── 1b. The CFO types goals; code bounds them; a signed policy re-prices the book ────
/** The CFO types goals → Claude proposes → rails → dry run against every buyer → signed with the CFO's key → the desk verifies and applies. */
async function cfoChange(goals: string, opts: { showTamper?: boolean } = {}) {
  const current = { credit: desk.creditPolicy(), terms: desk.salesTerms() };
  const compiled = await compileGoals(target, goals, current);
  const railed = applyRails(current, compiled.proposal);
  const diff = await desk.dryRunPolicy(railed.policy);
  for (const c of railed.accepted) console.log(`  ✔ ${policyChangeText(c)}${c.cfoWords ? `  ← "${c.cfoWords}"` : ""}`);
  for (const c of railed.rejected) console.log(`  ✘ ${policyChangeText(c)}: ${c.why}`);
  for (const n of compiled.proposal.notCompiled) console.log(`  ∅ not expressible: ${n.goal}`);
  for (const d of diff) console.log(`  dry run · ${d.name}: ${d.before.terms} $${(d.before.limit / 100).toFixed(2)} → ${d.after.terms} $${(d.after.limit / 100).toFixed(2)}${d.wouldCollect ? ` · would collect $${(d.wouldCollect / 100).toFixed(2)} now` : ""}`);
  const signed = signPolicy({ policy: railed.policy, goals, summary: compiled.proposal.summary, accepted: railed.accepted, rejected: railed.rejected, notCompiled: compiled.proposal.notCompiled, model: compiled.model }, NORTHWIND.cfoPolicyKey.key);
  if (opts.showTamper) {
    // Someone edits the signed policy to 5% off before it reaches the desk: refused.
    const edited = { ...signed, policy: { ...signed.policy, terms: { ...signed.policy.terms, earlyPay: { ...signed.policy.terms.earlyPay, discount: 0.05 } } } };
    await desk.applyPolicy(edited, diff);
  }
  await desk.applyPolicy(signed, diff);
}

say("1b · Northwind's CFO types this quarter's goals; Claude compiles them, code checks them, the desk dry-runs them");
await cfoChange("Cash is tight this quarter, so we want to be paid faster: offer 3% off to any buyer who pays within 10 days. Keep net-30 for buyers with a clean record, but no single buyer above $350 on credit. And give our best customers net-90.", { showTamper: true });
tail();
await pause();

// ── 2. Acme's agent shops ────────────────────────────────────────────────────
say("2 · Acme's agent (Claude) shops and chooses how to pay");
const acmeRun = await runBuyerAgent(target, desk, ACME_AGENT);
tail();
console.log(`  (${acmeRun.toolCalls} tool calls, ${acmeRun.orders.length} orders)`);
await pause();

// ── 3. Globex: no history with us → a card-secured tab → only the undisputed amount captured → earns terms ─
say("3 · Globex is new to Northwind: no Metal terms yet, but a Visa authorisation can secure a short tab");
await showBooks("globex");
await bindLine("globex", globexAcct.account, GLOBEX_OWNER, 9_000);
const g1 = await runBuyerAgent(target, desk, { ...GLOBEX_AGENT, goal: "We're launching a pricing product: buy 5,000 rows of FX tick backfill now. Pay as late as Northwind allows." });
tail();
console.log(`  (first Globex run: ${g1.toolCalls} tool calls)`);
const globexCard = state.buyers.globex!.orders.filter((o) => (o.route === "CARD_AUTH" && !o.card) || (o.route === "PREPAY_VIC" && !o.collectedBy));
if (globexCard.length && LIVE_VIC) {
  const secured = globexCard.every((o) => o.route === "CARD_AUTH");
  const st = await openCardStatement(awx, { statementId: `STM-${run}-G1`, hash: batchPaymentId("globex", globexCard), lines: globexCard.map((o) => ({ name: o.description.replace(/[,:]/g, ""), amount: o.amount })), paymentMethodId: AIRI_TEST_CARD, buyerAgent: "Globex sourcing agent", merchantName: "Northwind Data", merchantUrl: "https://northwind.example", buyerId: "globex" });
  console.log(`\n  ▶ APPROVE THE PASSKEY: ${st.passkeyUrl}\n`);
  const auth = await authoriseCardStatement(awx, st, `data/vic/${st.statementId}.cred.json`);
  const ids = { paymentIntentId: st.paymentIntentId, airiMandateId: st.airiMandateId, statementId: st.statementId, statementHash: st.hash };
  if (auth.ok && secured) {
    await desk.recordCardAuthorisation("globex", globexCard.map((o) => o.id), ids);
    tail();
    await pause();
    say("3b · Before the due date, Northwind's delivery QA flags one 1,000-row batch as stale: a credit note");
    const backfill = globexCard.find((o) => o.productId === "fx-backfill") ?? globexCard[0]!;
    // One batch of the order, at what Globex was actually charged for it.
    desk.applyCredit("globex", backfill.id, Math.round(backfill.amount / (backfill.units ?? 1)), "delivery QA: one 1,000-row batch had stale ticks", 1);
    tail();
    await pause();
    say("3c · Due (compressed for the video): capture only the undisputed amount; the rest of the hold lapses");
    await captureCard(awx, st, desk.cardCaptureAmount("globex", st.paymentIntentId));
    await desk.verifyCardCapture("globex", st.paymentIntentId);
    tail();
  } else if (auth.ok) {
    await captureCard(awx, st, st.total);
    await desk.verifyVicPayment("globex", ids);
    tail();
  }
  if (auth.ok) {
    await pause();
    say("3d · A settled Visa payment on record: Globex now qualifies for Metal terms, and its agent re-plans");
    await runBuyerAgent(target, desk, { ...GLOBEX_AGENT, goal: "The backfill is paid for. Now buy 2,000 market-data queries, on the best terms Northwind offers." });
    tail();
  }
} else if (globexCard.length) {
  console.log("  (LIVE_VIC not set: no card authorisation, so Globex's card order stays unpaid and Globex stays without terms)");
}
await pause();

// ── 4. Initech: overdue in the books; a scripted attacker is refused ─────────────
say("4 · Initech's books show an overdue invoice: prepay only, and orders for terms it is not offered are refused");
await showBooks("initech");
await desk.evaluate("initech");
for (const a of [
  // A buyer asking for terms it is not offered: the order is checked against the code-computed offer, whatever it says.
  { productId: "sla-day", units: 10, option: "net_30" as const },
  { productId: "sla-day", units: 9, option: "prepay_card" as const },
]) await desk.placeAgentOrder("initech", a);
tail();
await pause();

// ── 5. Dispute before money moves ──────────────────────────────────────────────
say("5 · Acme disputes stale data; the model reads, code decides, before anything is collected");
const acme = state.buyers.acme!;
const disputed = acme.orders.find((o) => o.productId === "mkt-queries" && o.route === "ON_TAB") ?? acme.orders.find((o) => o.route === "ON_TAB");
if (disputed) {
  disputed.staleUnits = Math.max(1, Math.round((disputed.units ?? 1) * 0.1)); // delivery QA flagged 10% stale
  const email = `Hi Northwind,\n\nOur agent never agreed to these prices, and the data in order ${disputed.id} was stale: all ${disputed.units} units had yesterday's values. Please refund it.\n\nPriya, Finance, Acme`;
  const read = await readDispute(target.client as any, target.model, email, acme.orders.map((o) => ({ id: o.id, description: o.description, priceRoute: `${o.priceRoute} (${o.unitPrice}¢ per unit)`, units: o.units ?? 1, placedAt: o.placedAt })), target.requestExtras);
  desk.resolveDispute("acme", decideDispute(read.claims, desk.evidenceFor("acme")), { summary: read.summary, model: read.model });
}
tail();
await pause();

// ── 5b. Mid-book: the CFO tightens with tabs open; the book re-prices and the excess is collected ─
say("5b · Mid-book, with tabs open, the CFO caps any single buyer's credit; the dry run shows what it costs, then the desk collects the excess on chain");
await cfoChange("A large customer just failed to pay another supplier, so cut our concentration risk: until month end, no single buyer may owe us more than $100 on credit, whatever their terms. Keep the 3% early-pay discount.");
tail();
await pause();

// ── 6. The statement is the mandate ─────────────────────────────────────────────
say("6 · Acme's statement becomes its own Metal mandate; the chain enforces the terms");
const groups = new Map<string, number>();
for (const o of acme.orders.filter((x) => x.route === "ON_TAB" && !x.collectedBy && x.dueAt)) groups.set(o.dueAt!.slice(0, 10), (groups.get(o.dueAt!.slice(0, 10)) ?? 0) + dueOn(o));
const dueAt = [...groups.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
let statementTx: string | undefined;
let statementTotal = 0;
if (dueAt) {
  const draft = desk.draftStatement("acme", dueAt)!;
  const startsIn = 75; // the real due date is in days; compressed to seconds for the video
  const graceSeconds = 300;
  const cred = `keys/acme-${run}-${draft.id}.json`;
  const issued = await metal.issueCredential({ principal: ACME.account, cap: draft.total, budget: draft.total, maxOccurrences: 1, startsIn, expiresIn: startsIn + graceSeconds, payee: SUPPLIER, payeeLabel: "Northwind Data", issuerKey: ISSUER.key, out: cred, description: `${draft.id} sha256 ${draft.hash.slice(2, 18)}` });
  const accepted = await metal.bind({ credential: cred, ownerKey: ACME.owner, issuerPublic: ISSUER.pub });
  desk.recordStatement("acme", { ...draft, graceEndsAt: issued.expiresAt ?? "", dueAt: issued.startsAt ?? dueAt, credential: cred, mandateKeyFile: issued.mandateKeyFile, mandateId: issued.mandateId, acceptTx: accepted.tx });
  tail();
  await pause();
  say("6b · Try to collect early");
  await desk.collectStatement("acme", draft.id);
  tail();
  const wait = Date.parse(issued.startsAt ?? "") - Date.now() + 5_000;
  if (wait > 0) {
    console.log(`  … waiting ${Math.round(wait / 1000)}s for the due time`);
    await sleep(wait);
  }
  say("6c · Collect on time, then try to double-charge with a fresh payment id");
  const paid = await desk.collectStatement("acme", draft.id);
  if (paid.outcome === "paid") {
    statementTx = paid.tx;
    statementTotal = draft.total;
  }
  await desk.collectStatement("acme", draft.id, { paymentId: `0x${run}replay` });
  await desk.evaluate("acme"); // fresh limit after the money left Acme's account
  tail();
}
await pause();

// ── 7. Globex's human cuts its credit line ──────────────────────────────────────
const globex = state.buyers.globex!;
if (globex.orders.some((o) => o.route === "ON_TAB" && !o.collectedBy)) {
  // The human lowers the line to just above what Globex owes: the limit tightens, so the desk
  // collects the whole tab at once while the new mandate still covers it.
  const owed = globex.orders.filter((o) => o.route === "ON_TAB" && !o.collectedBy).reduce((s, o) => s + dueOn(o), 0);
  const lastLimit = Number((state.events.filter((e) => e.buyerId === "globex" && e.type === "decision").at(-1)?.data as any)?.decision?.limit ?? 0);
  const cutTo = Math.max(owed, Math.min(owed + 500, lastLimit - 100));
  say(`7 · Globex's human cuts the credit line to $${(cutTo / 100).toFixed(2)}; the desk collects the tab before it's gone`);
  await bindLine("globex", globexAcct.account, GLOBEX_OWNER, cutTo, { credential: globex.credential!, mandateKeyFile: globex.mandateKeyFile! });
  await desk.evaluate("globex");
  tail();
  await pause();
}

// ── 8. Settle into Airwallex and book in T:0 ────────────────────────────────────
// Every Metal collection in this run is settled: Acme's statement and Globex's tab.
const toSettle = state.events
  .filter((e) => e.type === "collect" && e.data.tx && Number(e.data.amount) > 0)
  .map((e) => ({ buyerId: e.buyerId, tx: String(e.data.tx), amount: Number(e.data.amount) }))
  .filter((c, i, all) => all.findIndex((x) => x.tx === c.tx) === i);
if (toSettle.length) say("8 · Settle every collection into Airwallex, convert to SGD, book in T:0 where the customer lives there");
for (const c of toSettle) {
  const name = state.buyers[c.buyerId]!.name;
  const out = await settleCollection(awx, new FileLedger("data/settlements.json"), USD_GLOBAL_ACCOUNT, { metalTxHash: c.tx, amount: c.amount, payerName: name }, async () => false);
  if (out.kind === "converted") {
    desk.recordSettlement(c.buyerId, `deposited $${(c.amount / 100).toFixed(2)} into Airwallex, kept $${(out.reserved / 100).toFixed(2)} refund reserve, converted ${out.quote.sell_amount} USD → ${out.quote.buy_amount} SGD`, { depositId: out.depositId, quoteId: out.quote.quote_id, conversionId: out.conversionId, rate: out.quote.client_rate, metalTx: c.tx, sgdCents: Math.round(Number(out.quote.buy_amount) * 100) });
    const t0Customer = t0Customers[c.buyerId];
    if (t0 && t0Customer) {
      const je = await bookCollection(t0, { customerExternalId: t0Customer, amount: c.amount, currency: "USD", metalTx: c.tx, depositId: out.depositId, conversionId: out.conversionId, date: new Date() });
      desk.recordBooks(c.buyerId, `booked in T:0${je.jeNumber ? ` as ${je.jeNumber}` : ""}: debit Airwallex cash, credit A/R $${(c.amount / 100).toFixed(2)}`, { source: "t0", journalEntryId: je.journalEntryId, metalTx: c.tx });
    } else if (t0) {
      desk.recordBooks(c.buyerId, `not booked in T:0: ${name} has no transactions in T:0 yet, so T:0 cannot name it on a journal entry`, { source: books.sourceFor?.(c.buyerId) ?? books.source, metalTx: c.tx });
    }
  } else {
    desk.recordSettlement(c.buyerId, `settlement: ${out.kind}${"reason" in out ? ` (${out.reason})` : ""}`, {});
  }
  tail();
  await pause();
}

// ── 8b. Pay a vendor bill, once, only from proven money ─────────────────────────
// Northwind keeps its treasury in SGD built only from proven collections. It reads its open vendor
// bills from T:0; code pays the oldest one that proven money covers (keeping a floor back) and sends
// the rest to a person. One Airwallex transfer, funded in SGD, paid in the bill's currency.
if (t0) {
  say("8b · Northwind pays a vendor bill from its T:0 books, once, only from the SGD this run proved");
  const bills = await openVendorBills(t0);
  const costs = new Map<string, number>();
  for (const b of bills) costs.set(b.id, (await quoteSgdCost(awx, b.currency, b.amount)).sgdCents);
  const done = payoutsOf(state);
  const decisions = decidePayouts(bills, costs, { provenSgd: provenSgdOf(state), spentSgd: done.spentSgd, paidBillIds: done.paidBillIds });
  const beneficiaries = existsSync("data/payout/beneficiaries.json") ? (JSON.parse(readFileSync("data/payout/beneficiaries.json", "utf8")) as Record<string, string>) : {};
  for (const d of decisions) {
    const b = d.bill;
    const ben = beneficiaries[b.vendorId];
    if (d.verdict === "pay" && ben) {
      const paid = await payVendorBill(awx, { bill: b, beneficiaryId: ben, requestId: `tab-${run}-${b.id}`, simulate: true });
      desk.recordPayout({ billId: b.id, billNumber: b.number, vendor: b.vendorName, currency: b.currency, amount: b.amount, sgdCents: paid.sgdCents, transferId: paid.transferId, shortRef: paid.shortRef, status: paid.status, requestId: paid.requestId, reason: d.reason });
      const je = await bookPayout(t0, { bill: b, transferId: paid.transferId, shortRef: paid.shortRef, date: new Date() });
      desk.recordBooks("desk", `booked in T:0${je.jeNumber ? ` as ${je.jeNumber}` : ""}: debit A/P - Vendors (${b.vendorName}), credit Airwallex cash ${b.currency} ${(b.amount / 100).toFixed(2)}`, { source: "t0", journalEntryId: je.journalEntryId, payoutTransferId: paid.transferId, amount: b.amount });
      if (t0Import) {
        const bp = await recordBillPayment(t0Import, { bill: b, transferId: paid.transferId, shortRef: paid.shortRef, date: new Date() });
        desk.recordBooks("desk", `recorded in T:0 against bill ${b.number}: a bill payment of ${b.currency} ${(b.amount / 100).toFixed(2)} by Airwallex transfer ${paid.shortRef || paid.transferId}`, { source: "t0", billPaymentRecord: bp, billId: b.id, payoutTransferId: paid.transferId });
      }
    } else if (d.verdict === "pay") {
      desk.recordPayoutHeld({ billId: b.id, billNumber: b.number, vendor: b.vendorName, currency: b.currency, amount: b.amount, verdict: "person", reason: "proven money covers it, but there are no bank details on file for this vendor: a person adds them" });
    } else {
      desk.recordPayoutHeld({ billId: b.id, billNumber: b.number, vendor: b.vendorName, currency: b.currency, amount: b.amount, verdict: d.verdict, reason: d.reason });
    }
  }
  tail();
  await pause();
}

// ── 9. Every dollar proven ───────────────────────────────────────────────────────
say("9 · Every dollar proven");
const rpc = cfg.METAL_RPC_URL!;
const live = await checkLive(state, {
  receiptStatus: async (tx) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] }) }).then((x) => x.json() as Promise<{ result?: { status?: string } }>);
    return r.result?.status ?? null;
  },
  receipt: (tx) => txReceipt(cfg.METAL_RPC_URL!, tx),
  supplier: SUPPLIER,
  token: USDZ,
  conversionStatus: async (id) => (await awx.get<{ status: string }>(`/fx/conversions/${id}`)).status,
  paymentIntent: (id) => awx.get<{ status: string; captured_amount?: number }>(`/pa/payment_intents/${id}`),
  transfer: (id) => awx.get<{ status: string; source_amount: number; transfer_amount: number }>(`/transfers/${id}`),
  ...(t0 ? { journalEntry: async (id: string) => t0.call<{ total_debit_atoms: number; total_credit_atoms: number }>("get_one_journal_entry", { journal_entry_id: id }) } : {}),
});
const checks = [...checkBooks(state), ...live];
const breaks = checks.filter((c) => !c.ok);
desk.recordProof(`${checks.length} checks across the desk, Metal, Airwallex and T:0 · ${breaks.length} break(s)`, checks);
tail();
for (const c of checks) console.log(`  ${c.ok ? "✔" : "✘"} ${c.name}: ${c.detail}`);
console.log(`\n✔ demo run ${run} complete · ${state.events.length} events in ${DESK_FILE}`);
