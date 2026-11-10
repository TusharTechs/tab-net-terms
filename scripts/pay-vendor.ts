/**
 * Runs the vendor-payout step on its own against a desk file: reads the open vendor bills from T:0,
 * decides in code which one proven SGD can pay, pays it with one Airwallex transfer (sandbox: moved to
 * PAID by the simulation call), books it in T:0, then re-runs the proof.
 *   npx tsx scripts/pay-vendor.ts [deskFile]
 * The demo run does the same as its scene 8b; this is for trying it without a full run.
 */
import { existsSync, readFileSync } from "node:fs";
import { AirwallexClient } from "../src/airwallex/client.js";
import { StandinBooks, T0Mcp } from "../src/books/books.js";
import { config } from "../src/config.js";
import { Desk, type DeskState, fileStore } from "../src/desk/desk.js";
import { NORTHWIND } from "../src/desk/northwind.js";
import { MetalAgent, txReceipt, USDZ, usdzBalance } from "../src/metal/agent.js";
import { bookPayout, decidePayouts, openVendorBills, payoutsOf, payVendorBill, provenSgdOf, quoteSgdCost } from "../src/payout/vendor.js";
import { checkBooks, checkLive } from "../src/proof/checker.js";

const [deskFile = "data/desk-demo.json"] = process.argv.slice(2);
const cfg = config();
if (!cfg.T0_API_KEY || !cfg.METAL_RPC_URL) throw new Error("T0_API_KEY and METAL_RPC_URL are needed");
const rpc = cfg.METAL_RPC_URL;
const store = fileStore(deskFile);
const state = JSON.parse(readFileSync(deskFile, "utf8")) as DeskState;
const awx = new AirwallexClient({ baseUrl: cfg.AWX_BASE_URL, clientId: cfg.AWX_CLIENT_ID, apiKey: cfg.AWX_API_KEY });
const t0 = new T0Mcp(cfg.T0_API_KEY);
const desk = new Desk(state, { supplierPayee: NORTHWIND.supplier, policyPublicKey: NORTHWIND.cfoPolicyKey.pub, metal: new MetalAgent(), balanceOf: (a) => usdzBalance(rpc, a), books: new StandinBooks("fixtures/standin-books.json"), now: () => new Date(), persist: store.save });
const run = `pv${Date.now().toString(36)}`;

const bills = await openVendorBills(t0);
const costs = new Map<string, number>();
for (const b of bills) costs.set(b.id, (await quoteSgdCost(awx, b.currency, b.amount)).sgdCents);
const done = payoutsOf(state);
const proven = provenSgdOf(state);
console.log(`proven SGD ${(proven / 100).toFixed(2)}, already paid out SGD ${(done.spentSgd / 100).toFixed(2)}`);
const beneficiaries = existsSync("data/payout/beneficiaries.json") ? (JSON.parse(readFileSync("data/payout/beneficiaries.json", "utf8")) as Record<string, string>) : {};
for (const d of decidePayouts(bills, costs, { provenSgd: proven, spentSgd: done.spentSgd, paidBillIds: done.paidBillIds })) {
  const b = d.bill;
  const ben = beneficiaries[b.vendorId];
  if (d.verdict === "pay" && ben) {
    const paid = await payVendorBill(awx, { bill: b, beneficiaryId: ben, requestId: `tab-${run}-${b.id}`, simulate: true });
    desk.recordPayout({ billId: b.id, billNumber: b.number, vendor: b.vendorName, currency: b.currency, amount: b.amount, sgdCents: paid.sgdCents, transferId: paid.transferId, shortRef: paid.shortRef, status: paid.status, requestId: paid.requestId, reason: d.reason });
    const je = await bookPayout(t0, { bill: b, transferId: paid.transferId, shortRef: paid.shortRef, date: new Date() });
    desk.recordBooks("desk", `booked in T:0${je.jeNumber ? ` as ${je.jeNumber}` : ""}: debit A/P - Vendors (${b.vendorName}), credit Airwallex cash ${b.currency} ${(b.amount / 100).toFixed(2)}`, { source: "t0", journalEntryId: je.journalEntryId, payoutTransferId: paid.transferId, amount: b.amount });
    console.log(`PAID ${b.vendorName} ${b.number} ${b.currency} ${(b.amount / 100).toFixed(2)}: transfer ${paid.transferId} (${paid.shortRef}) ${paid.status}, SGD ${(paid.sgdCents / 100).toFixed(2)}; T:0 ${je.jeNumber ?? ""} ${je.journalEntryId}`);
  } else {
    const verdict = d.verdict === "pay" ? "person" : d.verdict;
    const reason = d.verdict === "pay" ? "no bank details on file for this vendor: a person adds them" : d.reason;
    desk.recordPayoutHeld({ billId: b.id, billNumber: b.number, vendor: b.vendorName, currency: b.currency, amount: b.amount, verdict, reason });
    console.log(`held  ${b.vendorName} ${b.number} ${b.currency} ${(b.amount / 100).toFixed(2)}: ${reason}`);
  }
}

const live = await checkLive(state, {
  receiptStatus: async (tx) => (await txReceipt(rpc, tx))?.status ?? null,
  receipt: (tx) => txReceipt(rpc, tx),
  supplier: NORTHWIND.supplier,
  token: USDZ,
  conversionStatus: async (id) => (await awx.get<{ status: string }>(`/fx/conversions/${id}`)).status,
  paymentIntent: (id) => awx.get<{ status: string; captured_amount?: number }>(`/pa/payment_intents/${id}`),
  transfer: (id) => awx.get<{ status: string; source_amount: number; transfer_amount: number }>(`/transfers/${id}`),
  journalEntry: (id) => t0.call<{ total_debit_atoms: number; total_credit_atoms: number }>("get_one_journal_entry", { journal_entry_id: id }),
});
const checks = [...checkBooks(state), ...live];
const breaks = checks.filter((c) => !c.ok);
desk.recordProof(`${checks.length} checks across the desk, Metal, Airwallex and T:0 · ${breaks.length} break(s)`, checks);
for (const c of checks.filter((x) => /vendor|journal|payout/.test(x.name) || !x.ok)) console.log(`${c.ok ? "✔" : "✘"} ${c.name}: ${c.detail}`);
console.log(`${checks.length - breaks.length}/${checks.length} checks pass`);
