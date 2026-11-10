import { describe, expect, it } from "vitest";
import type { Books } from "../src/books/books.js";
import { Desk, type DeskState } from "../src/desk/desk.js";
import type { MandateStatus, PullOutcome } from "../src/metal/agent.js";
import { checkBooks, checkLive } from "../src/proof/checker.js";

const NOW = new Date("2026-11-10T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const history = [1, 2, 3].map((i) => ({ id: `I${i}`, amount: 1, dueDate: day(-10 * i), paidAt: day(-10 * i - 1) }));

function setup() {
  const m = { budget: 100_000, spent: 0, paid: new Map<string, string>(), n: 0, pendingOnce: false };
  const metal = {
    status: async (): Promise<MandateStatus> => ({ mandateId: "0x", bound: true, revoked: false, spent: m.spent, budget: m.budget, payments: 0, capPerPayment: 100_000, payees: ["S"] }),
    pull: async (p: { amount: number; paymentId: string }): Promise<PullOutcome> => {
      const prior = m.paid.get(p.paymentId);
      if (prior) return { outcome: "paid", tx: prior, alreadyPaid: true, spent: "" };
      if (m.spent + p.amount > m.budget) return { outcome: "refused", reason: "mandate_budget_spent", detail: "" };
      m.spent += p.amount;
      const tx = `0xtx${++m.n}`;
      m.paid.set(p.paymentId, tx);
      if (m.pendingOnce) { m.pendingOnce = false; return { outcome: "pending", tx }; }
      return { outcome: "paid", tx, alreadyPaid: false, spent: "" };
    },
  };
  const books: Books = { source: "standin", invoicesFor: async () => history };
  const state: DeskState = { buyers: { acme: { id: "acme", name: "A", account: "0xA", credential: "c", mandateKeyFile: "k", vicSettledCount: 1, orders: [] } }, events: [] };
  return { desk: new Desk(state, { supplierPayee: "S", metal, balanceOf: async () => 1_000_000, books, now: () => NOW }), state, m };
}

describe("every dollar proven", () => {
  it("holds through orders, a pending pull, a credit issued in flight, and collections", async () => {
    const { desk, state, m } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "net_30" });
    m.pendingOnce = true;
    m.budget = 50_000;
    await desk.evaluate("acme");
    desk.applyCredit("acme", state.buyers.acme!.orders[0]!.id, 500, "stale");
    await desk.placeAgentOrder("acme", { productId: "sla-day", units: 1, option: "net_30" });
    m.budget = 40_000;
    await desk.evaluate("acme");
    const checks = checkBooks(state);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(m.spent).toBe(12_000 + 2_500 - 500);
  });

  it("catches a tampered log: an order collected twice", async () => {
    const { desk, state, m } = setup();
    await desk.placeAgentOrder("acme", { productId: "sla-day", units: 1, option: "net_30" });
    m.budget = 50_000;
    await desk.evaluate("acme");
    const c = state.events.find((e) => e.type === "collect")!;
    state.events.push({ ...c, seq: 999, data: { ...c.data, tx: "0xforged", paymentId: "0xother" } });
    const broken = checkBooks(state).filter((x) => !x.ok).map((x) => x.name);
    expect(broken).toEqual(expect.arrayContaining(["acme: no order collected twice", "acme: charged − credits = collected + open − credit owed"]));
  });

  it("live: flags a collection whose receipt did not succeed", async () => {
    const { desk, state, m } = setup();
    await desk.placeAgentOrder("acme", { productId: "sla-day", units: 1, option: "net_30" });
    m.budget = 50_000;
    await desk.evaluate("acme");
    const live = await checkLive(state, { receiptStatus: async () => "0x0" });
    expect(live[0]!.ok).toBe(false);
  });
});

describe("live: T:0 journal must equal what the chain collected", () => {
  it("flags a balanced entry booked for the wrong amount", async () => {
    const { desk, state, m } = setup();
    await desk.placeAgentOrder("acme", { productId: "sla-day", units: 1, option: "net_30" });
    m.budget = 50_000;
    await desk.evaluate("acme");
    const tx = String(state.events.find((e) => e.type === "collect")!.data.tx);
    desk.recordBooks("acme", "booked", { source: "t0", journalEntryId: "je_1", metalTx: tx });
    const ok = await checkLive(state, { receiptStatus: async () => "0x1", journalEntry: async () => ({ total_debit_atoms: 2_500, total_credit_atoms: 2_500 }) });
    expect(ok.find((c) => c.name.includes("je_1"))!.ok).toBe(true);
    const wrong = await checkLive(state, { receiptStatus: async () => "0x1", journalEntry: async () => ({ total_debit_atoms: 2_400, total_credit_atoms: 2_400 }) });
    expect(wrong.find((c) => c.name.includes("je_1"))).toMatchObject({ ok: false, detail: expect.stringMatching(/DOES NOT equal the \$25\.00/) });
  });
});

describe("deeper proof", () => {
  const SUP = "0x00000000000000000000000000000000000000aa";
  const pad = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const transfer = (from: string, to: string, cents: number) => ({ address: "0xToken", topics: [TRANSFER, pad(from), pad(to)], data: `0x${(BigInt(cents) * 10n ** 16n).toString(16).padStart(64, "0")}` });

  it("flags a stale-unit credit priced at list instead of what was charged", async () => {
    const { desk, state } = setup();
    await desk.placeAgentOrder("acme", { productId: "mkt-queries", units: 2_000, option: "pay_in_10_discount" }); // charged $78.40
    desk.applyCredit("acme", state.buyers.acme!.orders[0]!.id, 800, "200 stale at list", 200); // list price: wrong
    expect(checkBooks(state).find((c) => c.name === "acme: credits priced at what was charged")).toMatchObject({ ok: false });
    const { desk: d2, state: s2 } = setup();
    await d2.placeAgentOrder("acme", { productId: "mkt-queries", units: 2_000, option: "pay_in_10_discount" });
    d2.applyCredit("acme", s2.buyers.acme!.orders[0]!.id, 784, "200 stale at the charged price", 200);
    expect(checkBooks(s2).find((c) => c.name === "acme: credits priced at what was charged")).toMatchObject({ ok: true });
  });

  it("live: a collection must move exactly its amount from the buyer to the supplier", async () => {
    const { desk, state, m } = setup();
    await desk.placeAgentOrder("acme", { productId: "sla-day", units: 1, option: "net_30" });
    m.budget = 50_000;
    await desk.evaluate("acme");
    const run = (logs: ReturnType<typeof transfer>[]) => checkLive(state, { receiptStatus: async () => "0x1", supplier: SUP, receipt: async () => ({ status: "0x1", from: SUP, logs }) });
    const name = "every collection moved exactly its amount from the buyer to Northwind";
    expect((await run([transfer("0xA", SUP, 2_500)])).find((c) => c.name === name)!.ok).toBe(true);
    expect((await run([transfer("0xA", SUP, 2_400)])).find((c) => c.name === name)!.ok).toBe(false);
    expect((await run([transfer("0xA", "0x00000000000000000000000000000000000000bb", 2_500)])).find((c) => c.name === name)!.ok).toBe(false);
  });

  it("a buyer that never ordered adds no checks", () => {
    const { state } = setup();
    state.buyers.idle = { id: "idle", name: "I", account: "0xI", vicSettledCount: 0, orders: [] };
    expect(checkBooks(state).some((c) => c.name.startsWith("idle:"))).toBe(false);
  });
});
