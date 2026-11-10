import { describe, expect, it } from "vitest";
import type { Books } from "../src/books/books.js";
import { Desk, type DeskState } from "../src/desk/desk.js";
import type { MandateStatus, PullOutcome } from "../src/metal/agent.js";
import { checkBooks } from "../src/proof/checker.js";

/** Reproductions of the round-5 engineer's probes: each must now hold the books. */

let clock = new Date("2026-11-10T00:00:00Z");
const history = [1, 2, 3].map((i) => ({ id: `I${i}`, amount: 1, dueDate: new Date(clock.getTime() - i * 864e6), paidAt: new Date(clock.getTime() - i * 864e6 - 864e5) }));

function setup() {
  clock = new Date("2026-11-10T00:00:00Z");
  const pulls: { credential: string; amount: number }[] = [];
  const st = new Map<string, { start: number; end: number; budget: number; spent: number }>();
  const line = { budget: 100_000, spent: 0, pendingNext: false };
  const metal = {
    addStatement(cred: string, start: Date, end: Date, budget: number) { st.set(cred, { start: start.getTime(), end: end.getTime(), budget, spent: 0 }); },
    line,
    status: async (): Promise<MandateStatus> => ({ mandateId: "0x", bound: true, revoked: false, spent: line.spent, budget: line.budget, payments: 0, capPerPayment: 100_000, payees: ["S"] }),
    pull: async (p: { credential: string; amount: number; paymentId: string }): Promise<PullOutcome> => {
      pulls.push({ credential: p.credential, amount: p.amount });
      const m = st.get(p.credential);
      if (m) {
        if (clock.getTime() < m.start || clock.getTime() > m.end) return { outcome: "refused", reason: "mandate_outside_recurrence", detail: "" };
        if (m.spent + p.amount > m.budget) return { outcome: "refused", reason: "mandate_budget_spent", detail: "" };
        m.spent += p.amount;
        return { outcome: "paid", tx: `0xst${pulls.length}`, alreadyPaid: false, spent: "" };
      }
      if (line.pendingNext) { line.pendingNext = false; return { outcome: "pending" }; }
      line.spent += p.amount;
      return { outcome: "paid", tx: `0xline${pulls.length}`, alreadyPaid: false, spent: "" };
    },
  };
  const books: Books = { source: "standin", invoicesFor: async () => history };
  const state: DeskState = { buyers: { acme: { id: "acme", name: "A", account: "0xA", credential: "line.json", mandateKeyFile: "k", vicSettledCount: 1, orders: [] } }, events: [] };
  const desk = new Desk(state, { supplierPayee: "S", metal, balanceOf: async () => 1_000_000, books, now: () => clock });
  return { desk, state, metal, pulls };
}

async function bindStatement(desk: Desk, metal: ReturnType<typeof setup>["metal"], dueAt: string) {
  const d = desk.draftStatement("acme", dueAt);
  if (!d) return null;
  const start = new Date(d.dueAt);
  const end = new Date(start.getTime() + 3 * 864e5);
  metal.addStatement(`st-${d.id}`, start, end, d.total);
  desk.recordStatement("acme", { ...d, graceEndsAt: end.toISOString(), credential: `st-${d.id}`, mandateKeyFile: "k", mandateId: "0xst", acceptTx: "0xbind" });
  return d;
}

describe("money guards", () => {
  it("a statement never includes orders whose line pull is still in flight (no double debit)", async () => {
    const { desk, state, metal, pulls } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "pay_in_10_discount" });
    const due = state.buyers.acme!.orders[0]!.dueAt!;
    metal.line.budget = 20_000; // the human cuts the line: the desk tries to collect, Metal answers pending
    metal.line.pendingNext = true;
    await desk.evaluate("acme");
    expect(state.buyers.acme!.inflight?.orderIds).toEqual([state.buyers.acme!.orders[0]!.id]);
    expect(await bindStatement(desk, metal, due)).toBeNull();
    // The pending pull resolves; the order is paid exactly once.
    await desk.evaluate("acme");
    expect(pulls.filter((p) => p.credential.startsWith("st-"))).toEqual([]);
    expect(checkBooks(state).filter((c) => !c.ok)).toEqual([]);
  });

  it("a credit issued after a statement is bound is owed back, not lost", async () => {
    const { desk, state, metal } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "pay_in_10_discount" });
    const o = state.buyers.acme!.orders[0]!;
    const st = (await bindStatement(desk, metal, o.dueAt!))!;
    desk.applyCredit("acme", o.id, 1_200, "stale batch found after the statement was bound");
    expect(state.buyers.acme!.creditBalance).toBe(1_200);
    clock = new Date(Date.parse(st.dueAt) + 1_000);
    expect(await desk.collectStatement("acme", st.id)).toMatchObject({ outcome: "paid" });
    expect(checkBooks(state).filter((c) => !c.ok)).toEqual([]);
  });

  it("an unpaid statement can only be declared after grace, and takes back the credit it carried", async () => {
    const { desk, state, metal } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "pay_in_10_discount" });
    const o = state.buyers.acme!.orders[0]!;
    const st = (await bindStatement(desk, metal, o.dueAt!))!;
    desk.applyCredit("acme", o.id, 1_200, "stale");
    expect(() => desk.markStatementUnpaid("acme", st.id)).toThrow(/still inside its window/);
    clock = new Date(Date.parse(st.dueAt) + 4 * 864e5);
    desk.markStatementUnpaid("acme", st.id);
    expect(state.buyers.acme!.creditBalance).toBe(0);
    await expect(desk.collectStatement("acme", st.id)).rejects.toThrow(/went unpaid/);
    expect(checkBooks(state).filter((c) => !c.ok)).toEqual([]);
  });

  it("a collected statement is answered from the desk's record without touching the chain", async () => {
    const { desk, state, metal, pulls } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "pay_in_10_discount" });
    const st = (await bindStatement(desk, metal, state.buyers.acme!.orders[0]!.dueAt!))!;
    clock = new Date(Date.parse(st.dueAt) + 1_000);
    await desk.collectStatement("acme", st.id);
    const sent = pulls.length;
    expect(await desk.collectStatement("acme", st.id)).toMatchObject({ outcome: "paid", alreadyPaid: true });
    expect(pulls.length).toBe(sent);
  });
});
