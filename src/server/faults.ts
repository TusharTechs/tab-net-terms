import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { AirwallexClient } from "../airwallex/client.js";
import { type Books, RoutedBooks, StandinBooks, T0Books, T0Mcp } from "../books/books.js";
import { config } from "../config.js";
import { Desk, type DeskDeps, type DeskState, fileStore } from "../desk/desk.js";
import { BUYERS, NORTHWIND } from "../desk/northwind.js";
import { findTransfer, MetalAgent, txReceipt, USDZ, usdzBalance } from "../metal/agent.js";
import { type Check, checkBooks, checkLive } from "../proof/checker.js";

/**
 * "Try to make TAB double-charge": live fault injection. Each attempt goes to Metal testnet for
 * real; the buyer's on-chain balance is read before and after, and the proof re-runs. Demo-only:
 * the server enables it with ALLOW_FAULTS=1.
 */

export const FAULTS = {
  "same-id": "collect the paid statement again (same payment id)",
  "fresh-id": "collect it again under a fresh payment id",
  overcharge: "collect $1 more than the statement",
  crash: "kill the desk mid-pull on the credit line, then restart it",
} as const;
export type Fault = keyof typeof FAULTS;

/** The live rails a fault runs against. Tests pass fakes; the server uses Metal testnet, Airwallex and T:0. */
export interface FaultRails {
  metal: DeskDeps["metal"];
  books: Books;
  balanceOf(address: string): Promise<number>;
  findTransfer: NonNullable<DeskDeps["findTransfer"]>;
  liveChecks(state: DeskState): Promise<Check[]>;
}

export async function liveRails(): Promise<FaultRails> {
  const cfg = config();
  const rpc = cfg.METAL_RPC_URL;
  if (!rpc) throw new Error("METAL_RPC_URL missing");
  const awx = new AirwallexClient({ baseUrl: cfg.AWX_BASE_URL, clientId: cfg.AWX_CLIENT_ID, apiKey: cfg.AWX_API_KEY });
  const t0 = cfg.T0_API_KEY ? new T0Mcp(cfg.T0_API_KEY) : undefined;
  // The same books the demo uses: Acme's real T:0 history, the labelled stand-in for the others.
  const standin = new StandinBooks("fixtures/standin-books.json");
  const t0Books = t0 ? new T0Books(t0, { acme: BUYERS.acme.t0Customer }) : undefined;
  if (t0Books) await t0Books.refresh();
  return {
    metal: new MetalAgent(),
    books: t0Books ? new RoutedBooks({ acme: t0Books }, standin) : standin,
    balanceOf: (a) => usdzBalance(rpc, a),
    findTransfer: (p) => findTransfer(rpc, p),
    // The same full live proof the demo runs: transfers and refusals on chain, Airwallex conversions and card captures, T:0 entries.
    liveChecks: (state) =>
      checkLive(state, {
        receiptStatus: async (tx) => (await txReceipt(rpc, tx))?.status ?? null,
        receipt: (tx) => txReceipt(rpc, tx),
        supplier: NORTHWIND.supplier,
        token: USDZ,
        conversionStatus: async (id) => (await awx.get<{ status: string }>(`/fx/conversions/${id}`)).status,
        paymentIntent: (id) => awx.get<{ status: string; captured_amount?: number }>(`/pa/payment_intents/${id}`),
        ...(t0 ? { journalEntry: (id: string) => t0.call<{ total_debit_atoms: number; total_credit_atoms: number }>("get_one_journal_entry", { journal_entry_id: id }) } : {}),
      }),
  };
}

function deskOn(state: DeskState, deskFile: string, rails: FaultRails, metal: DeskDeps["metal"] = rails.metal): Desk {
  return new Desk(state, {
    supplierPayee: NORTHWIND.supplier,
    refusalKey: NORTHWIND.supplierWalletKey,
    policyPublicKey: NORTHWIND.cfoPolicyKey.pub,
    metal,
    balanceOf: rails.balanceOf,
    findTransfer: rails.findTransfer,
    books: rails.books,
    now: () => new Date(),
    persist: fileStore(deskFile).save,
  });
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const load = (f: string) => JSON.parse(readFileSync(f, "utf8")) as DeskState;

async function prove(desk: Desk, rails: FaultRails, summary: string): Promise<number> {
  const checks = [...checkBooks(desk.state), ...(await rails.liveChecks(desk.state))];
  const breaks = checks.filter((c) => !c.ok).length;
  desk.recordProof(`${summary} · ${checks.length - breaks}/${checks.length} checks pass`, checks);
  return breaks;
}

export async function runFault(fault: Fault, deskFile: string, rails?: FaultRails): Promise<{ ok: boolean; message: string }> {
  const r = rails ?? (await liveRails());
  return fault === "crash" ? runCrash(deskFile, r) : runStatementFault(fault, deskFile, r);
}

/** Attacks the last collected statement: its own single-use mandate. */
async function runStatementFault(fault: Exclude<Fault, "crash">, deskFile: string, rails: FaultRails) {
  const state = load(deskFile);
  const target = Object.values(state.buyers)
    .flatMap((b) => (b.statements ?? []).filter((s) => s.status === "collected").map((s) => ({ b, s })))
    .at(-1);
  if (!target) return { ok: false, message: "no collected statement to attack yet: run the demo first" };
  const { b, s } = target;
  const desk = deskOn(state, deskFile, rails);

  const before = await rails.balanceOf(b.account);
  const fresh = `0x${randomBytes(32).toString("hex")}`;
  const res =
    fault === "same-id" ? await desk.collectStatement(b.id, s.id)
    : fault === "fresh-id" ? await desk.collectStatement(b.id, s.id, { paymentId: fresh })
    : await desk.collectStatement(b.id, s.id, { paymentId: fresh, amount: s.total + 100 });
  const after = await rails.balanceOf(b.account);

  const outcome = res.outcome === "paid" ? (res.alreadyPaid ? `the desk's record answered "already paid" with the original tx ${res.tx.slice(0, 10)}…: nothing was sent to the chain` : `PAID ${res.tx}`) : res.outcome === "refused" ? `chain refused: ${res.reason}${res.recordedTx ? " (refusal recorded on chain)" : ""}` : res.outcome;
  const moved = before - after;
  const breaks = await prove(desk, rails, `after "${FAULTS[fault]}": ${outcome}; ${b.name}'s balance ${moved === 0 ? "did not move" : `moved by ${usd(moved)}`} (${usd(before)} → ${usd(after)})`);
  return { ok: moved === 0 && breaks === 0 && !(res.outcome === "paid" && !res.alreadyPaid), message: outcome };
}

/**
 * Kills the desk mid-pull on the credit line: a small order goes on Acme's tab, Acme asks to pay
 * now, the pull is sent to Metal for real, and the desk "dies" before it can record the answer.
 * Then a statement is drafted over the same orders (it must refuse them), and a fresh desk restarts
 * from what was on disk. It must take the payment from the chain and send nothing again.
 */
async function runCrash(deskFile: string, rails: FaultRails) {
  const buyerId = "acme";
  const state = load(deskFile);
  const b = state.buyers[buyerId];
  if (!b?.credential) return { ok: false, message: "Acme has no credit line bound: run the demo first" };

  let sent = 0;
  const dying: DeskDeps["metal"] = {
    status: (c) => rails.metal.status(c),
    pull: async (p) => {
      sent++;
      await rails.metal.pull(p); // reaches the chain…
      throw new Error("simulated crash: the desk died before recording Metal's answer"); // …but the answer is lost
    },
  };
  const before = await rails.balanceOf(b.account);
  const a = deskOn(state, deskFile, rails, dying);
  // A small order on whatever credit option the desk offers Acme right now.
  const offer = await a.offerFor(buyerId, "mkt-queries", 500);
  const option = offer.options.find((x) => x.option === "net_30" || x.option === "pay_in_10_discount" || x.option === "net_7")?.option;
  if (!option) return { ok: false, message: `Acme has no credit option for a test order right now (${offer.notes.join("; ")})` };
  const order = await a.placeAgentOrder(buyerId, { productId: "mkt-queries", units: 500, option });
  if (!order.ok) return { ok: false, message: `could not place the test order: ${order.reason}` };
  try {
    await a.payNow(buyerId);
    return { ok: false, message: "the simulated crash did not happen" };
  } catch {
    /* the process "died" here; what was persisted before the send is all that survives */
  }

  // Restart from disk.
  const restarted = load(deskFile);
  const inflight = restarted.buyers[buyerId]!.inflight;
  if (!inflight) return { ok: false, message: "no in-flight pull was recorded before sending: a restart could pay twice" };
  const countingMetal: DeskDeps["metal"] = { status: (c) => rails.metal.status(c), pull: async (p) => { sent++; return rails.metal.pull(p); } };
  const desk = deskOn(restarted, deskFile, rails, countingMetal);
  const due = restarted.buyers[buyerId]!.orders.find((o) => o.id === order.orderId)!.dueAt!;
  const statementRefused = desk.draftStatement(buyerId, due) === null;
  await desk.evaluate(buyerId);
  const after = await rails.balanceOf(b.account);
  const o = desk.state.buyers[buyerId]!.orders.find((x) => x.id === order.orderId)!;
  const moved = before - after;
  const once = sent === 1 && moved === order.amount && Boolean(o.collectedBy) && !desk.state.buyers[buyerId]!.inflight;
  const message = `${usd(order.amount)} pull sent once, then the desk died before recording it; ${statementRefused ? "a statement could not include the order while the pull was in flight; " : "a statement DID include the in-flight order; "}after restart the desk ${o.collectedBy ? `found it on chain (${o.collectedBy.slice(0, 10)}…) and sent nothing again` : "did not resolve it"}. Pulls sent: ${sent}; ${b.name}'s balance moved ${usd(moved)} (${usd(before)} → ${usd(after)})`;
  const breaks = await prove(desk, rails, `after "${FAULTS.crash}": ${message}`);
  return { ok: once && statementRefused && breaks === 0, message };
}
