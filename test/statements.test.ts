import { describe, expect, it } from "vitest";
import type { Books } from "../src/books/books.js";
import { Desk, type DeskState } from "../src/desk/desk.js";
import type { MandateStatus, PullOutcome } from "../src/metal/agent.js";

let clock = new Date("2026-11-10T00:00:00Z");
const SUPPLIER = "0xSupplier";
const day = (n: number) => new Date(clock.getTime() + n * 86_400_000);
const history = [1, 2, 3].map((i) => ({ id: `I${i}`, amount: 10_000, dueDate: day(-10 * i), paidAt: day(-10 * i - 1) }));

/** Statement mandates behave like Metal's: window, budget = total, pays once per payment-id. */
function fakeMetal() {
  const statements = new Map<string, { start: number; end: number; budget: number; spent: number; paid: Map<string, string> }>();
  const line = { budget: 100_000, spent: 0, paid: new Map<string, string>() };
  const pulls: { credential: string; amount: number; recorded: boolean }[] = [];
  let n = 0;
  return {
    pulls,
    line,
    addStatement(cred: string, start: Date, end: Date, budget: number) {
      statements.set(cred, { start: start.getTime(), end: end.getTime(), budget, spent: 0, paid: new Map() });
    },
    status: async (): Promise<MandateStatus> => ({ mandateId: "0xline", bound: true, revoked: false, spent: line.spent, budget: line.budget, payments: line.paid.size, capPerPayment: 100_000, payees: [SUPPLIER] }),
    pull: async (p: { credential: string; amount: number; paymentId: string; recordRefusalKey?: string }): Promise<PullOutcome> => {
      pulls.push({ credential: p.credential, amount: p.amount, recorded: Boolean(p.recordRefusalKey) });
      const st = statements.get(p.credential);
      const m = st ?? line;
      const prior = m.paid.get(p.paymentId);
      if (prior) return { outcome: "paid", tx: prior, alreadyPaid: true, spent: "" };
      const refuse = (reason: string): PullOutcome => ({ outcome: "refused", reason, detail: "", ...(p.recordRefusalKey ? { recordedTx: `0xrefusal${++n}` } : {}) });
      if (st && (clock.getTime() < st.start || clock.getTime() > st.end)) return refuse("mandate_outside_recurrence");
      if (m.spent + p.amount > m.budget) return refuse("mandate_budget_spent");
      m.spent += p.amount;
      const tx = `0xpaid${++n}`;
      m.paid.set(p.paymentId, tx);
      return { outcome: "paid", tx, alreadyPaid: false, spent: "" };
    },
  };
}

function setup() {
  clock = new Date("2026-11-10T00:00:00Z");
  const metal = fakeMetal();
  const books: Books = { source: "standin", invoicesFor: async () => history };
  const state: DeskState = { buyers: { acme: { id: "acme", name: "Acme", account: "0xA", credential: "line.json", mandateKeyFile: "line.key", vicSettledCount: 1, orders: [] } }, events: [] };
  const desk = new Desk(state, { supplierPayee: SUPPLIER, refusalKey: "keys/supplier-wallet.json", metal, balanceOf: async () => 1_000_000, books, now: () => clock });
  return { desk, metal, state };
}

async function issue(desk: Desk, metal: ReturnType<typeof fakeMetal>, dueAt: string) {
  const d = desk.draftStatement("acme", dueAt)!;
  const due = new Date(dueAt);
  const graceEnds = new Date(due.getTime() + 3 * 86_400_000);
  metal.addStatement(`st-${d.id}.json`, due, graceEnds, d.total);
  desk.recordStatement("acme", { ...d, graceEndsAt: graceEnds.toISOString(), credential: `st-${d.id}.json`, mandateKeyFile: "k", mandateId: "0xst", acceptTx: "0xbind" });
  return d;
}

describe("statement is the mandate", () => {
  it("groups orders by due date, nets credits, and its id/hash name exactly those orders", async () => {
    const { desk, state } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "pay_in_10_discount" });
    await desk.placeAgentOrder("acme", { productId: "sla-day", units: 1, option: "pay_in_10_discount" });
    await desk.placeAgentOrder("acme", { productId: "mkt-queries", units: 1_000, option: "net_30" });
    const due10 = state.buyers.acme!.orders[0]!.dueAt!;
    desk.applyCredit("acme", state.buyers.acme!.orders[1]!.id, 450, "stale");
    const d = desk.draftStatement("acme", due10)!;
    expect(d.orderIds).toHaveLength(2);
    expect(d.total).toBe(11_760 + 2_450 - 450);
  });

  it("orders placed minutes apart but due the same day share one statement, due at the latest of them", async () => {
    const { desk, state } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "pay_in_10_discount" });
    clock = new Date(clock.getTime() + 90_000);
    await desk.placeAgentOrder("acme", { productId: "sla-day", units: 1, option: "pay_in_10_discount" });
    const [a, b] = state.buyers.acme!.orders;
    expect(a!.dueAt).not.toBe(b!.dueAt);
    const d = desk.draftStatement("acme", a!.dueAt!)!;
    expect(d.orderIds).toEqual([a!.id, b!.id]);
    expect(d.dueAt).toBe(b!.dueAt);
  });

  it("early collection is refused and recorded; on time it pays; a repeat is refused and recorded", async () => {
    const { desk, metal, state } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "pay_in_10_discount" });
    const st = await issue(desk, metal, state.buyers.acme!.orders[0]!.dueAt!);

    expect(await desk.collectStatement("acme", st.id)).toMatchObject({ outcome: "refused", reason: "mandate_outside_recurrence", recordedTx: expect.any(String) });
    clock = day(10); // due
    expect(await desk.collectStatement("acme", st.id)).toMatchObject({ outcome: "paid" });
    expect(state.buyers.acme!.orders[0]!.collectedBy).toMatch(/^0xpaid/);
    // the same collection again is answered from the record: nothing new is paid
    expect(await desk.collectStatement("acme", st.id)).toMatchObject({ outcome: "paid", alreadyPaid: true });
    // a buggy/malicious second collection with a fresh payment-id reaches the chain and is refused
    expect(await desk.collectStatement("acme", st.id, { paymentId: "0xfresh" })).toMatchObject({ outcome: "refused", reason: "mandate_budget_spent" });
    expect(state.buyers.acme!.statements![0]!.refusals.map((r) => r.reason)).toEqual(["mandate_outside_recurrence", "mandate_budget_spent"]);
  });

  it("the credit line never pulls orders an accepted statement will collect", async () => {
    const { desk, metal, state } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "pay_in_10_discount" });
    await desk.placeAgentOrder("acme", { productId: "sla-day", units: 2, option: "net_30" });
    await issue(desk, metal, state.buyers.acme!.orders[0]!.dueAt!);
    metal.line.budget = 50_000; // human cuts the line → collect everything collectable now
    await desk.evaluate("acme");
    const linePulls = metal.pulls.filter((p) => p.credential === "line.json");
    expect(linePulls.map((p) => p.amount)).toEqual([5_000]); // only the net-30 SLA order, not the statement's 117.60
  });

  it("unpaid after grace: the statement's orders return to the credit-line backstop", async () => {
    const { desk, metal, state } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "pay_in_10_discount" });
    const st = await issue(desk, metal, state.buyers.acme!.orders[0]!.dueAt!);
    clock = day(14); // after grace
    expect(await desk.collectStatement("acme", st.id)).toMatchObject({ outcome: "refused", reason: "mandate_outside_recurrence" });
    desk.markStatementUnpaid("acme", st.id);
    metal.line.budget = 50_000;
    await desk.evaluate("acme");
    expect(metal.pulls.filter((p) => p.credential === "line.json").map((p) => p.amount)).toEqual([11_760]);
  });
});

describe("VIC gate verifies against Airwallex", () => {
  const make = (pi: any) => {
    const books: Books = { source: "standin", invoicesFor: async () => [] };
    const state: DeskState = { buyers: { acme: { id: "acme", name: "Acme", account: "0xA", vicSettledCount: 0, orders: [] } }, events: [] };
    const desk = new Desk(state, { supplierPayee: SUPPLIER, metal: fakeMetal(), balanceOf: async () => 0, books, now: () => clock, readPaymentIntent: async () => pi });
    return { desk, state };
  };
  const p = { paymentIntentId: "int_1", airiMandateId: "mdt_1", statementId: "STM-1", statementHash: "abc" };

  it("counts a captured payment whose order id and hash match", async () => {
    const { desk, state } = make({ status: "SUCCEEDED", captured_amount: 186, merchant_order_id: "STM-1", metadata: { statement_hash: "abc" } });
    expect(await desk.verifyVicPayment("acme", p)).toBe(true);
    expect(state.buyers.acme!.vicSettledCount).toBe(1);
  });

  it("does not count a payment for a different statement, or one not captured", async () => {
    expect(await make({ status: "SUCCEEDED", captured_amount: 186, merchant_order_id: "STM-1", metadata: { statement_hash: "zzz" } }).desk.verifyVicPayment("acme", p)).toBe(false);
    const r = make({ status: "REQUIRES_CAPTURE", captured_amount: 0, merchant_order_id: "STM-1", metadata: { statement_hash: "abc" } });
    expect(await r.desk.verifyVicPayment("acme", p)).toBe(false);
    expect(r.state.buyers.acme!.vicSettledCount).toBe(0);
  });
});
