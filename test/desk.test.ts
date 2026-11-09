import { describe, expect, it } from "vitest";
import type { Books } from "../src/books/books.js";
import type { InvoiceRecord } from "../src/domain/credit.js";
import { batchPaymentId, Desk, type DeskState } from "../src/desk/desk.js";
import type { MandateStatus } from "../src/metal/agent.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const SUPPLIER = "0xSupplier";
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

/** Behaves like a Metal mandate: budget enforced, spend carried, payment-id pays at most once. */
class FakeMandate {
  budget = 90_000;
  spent = 0;
  revoked = false;
  paid = new Map<string, string>();
  pulls: { amount: number; paymentId: string }[] = [];
  status = async (): Promise<MandateStatus> => ({ mandateId: "0xm", bound: true, revoked: this.revoked, spent: this.spent, budget: this.budget, payments: this.paid.size, capPerPayment: 50_000, payees: [SUPPLIER] });
  pull = async (p: { amount: number; paymentId: string }) => {
    this.pulls.push({ amount: p.amount, paymentId: p.paymentId });
    const prior = this.paid.get(p.paymentId);
    if (prior) return { outcome: "paid" as const, tx: prior, alreadyPaid: true, spent: "" };
    if (this.revoked) return { outcome: "refused" as const, reason: "mandate_revoked", detail: "" };
    if (this.spent + p.amount > this.budget) return { outcome: "refused" as const, reason: "mandate_budget_spent", detail: "" };
    this.spent += p.amount;
    const tx = `0xtx${this.paid.size + 1}`;
    this.paid.set(p.paymentId, tx);
    return { outcome: "paid" as const, tx, alreadyPaid: false, spent: "" };
  };
}

const goodHistory: InvoiceRecord[] = [1, 2, 3].map((i) => ({ id: `INV-${i}`, amount: 10_000, dueDate: day(-10 * i), paidAt: day(-10 * i - 1) }));

function setup(invoices: InvoiceRecord[] = goodHistory) {
  const mandate = new FakeMandate();
  const books: Books = { source: "standin", invoicesFor: async () => invoices };
  const state: DeskState = {
    buyers: { acme: { id: "acme", name: "Acme", account: "0xAcme", credential: "keys/m.json", mandateKeyFile: "keys/m.key.json", vicSettledCount: 1, orders: [] } },
    events: [],
  };
  const desk = new Desk(state, { supplierPayee: SUPPLIER, metal: mandate, balanceOf: async () => 500_000, books, now: () => NOW });
  return { desk, mandate, state };
}

describe("Desk", () => {
  it("hook: orders go on the tab; the human cuts the mandate; the desk collects exactly those orders", async () => {
    const { desk, mandate, state } = setup();
    for (const [id, amount] of [["o1", 6_000], ["o2", 7_000], ["o3", 5_000]] as const) {
      expect(await desk.placeOrder("acme", { id, amount, description: "data" })).toEqual({ kind: "ON_TAB" });
    }
    expect(mandate.pulls).toHaveLength(0);

    mandate.budget = 25_000; // buyer's human replaces the mandate with a lower budget
    const d = await desk.evaluate("acme");
    expect(d.limit).toBe(25_000);
    expect(d.collectNow).toBe(18_000);
    expect(mandate.pulls).toEqual([{ amount: 18_000, paymentId: batchPaymentId("acme", [{ id: "o1", amount: 6_000 }, { id: "o2", amount: 7_000 }, { id: "o3", amount: 5_000 }]) }]);
    expect(state.buyers.acme!.orders.every((o) => o.collectedBy === "0xtx1")).toBe(true);
    expect(state.events.some((e) => e.type === "collect" && e.summary.includes("$180.00"))).toBe(true);
  });

  it("after the cut, a big order no longer fits and goes to prepay; over $200 it goes to invoice, never split", async () => {
    const { desk, mandate } = setup();
    await desk.placeOrder("acme", { id: "o1", amount: 18_000, description: "data" });
    mandate.budget = 25_000;
    await desk.evaluate("acme");
    expect(await desk.placeOrder("acme", { id: "o2", amount: 30_000, description: "bulk" })).toEqual({ kind: "PREPAY_INVOICE", reason: "OVER_VIC_CAP" });
    expect(await desk.placeOrder("acme", { id: "o3", amount: 15_000, description: "small" })).toEqual({ kind: "PREPAY_VIC" });
  });

  it("an overdue invoice in the books demotes the buyer and collects what it owes", async () => {
    const { desk, mandate, state } = setup();
    await desk.placeOrder("acme", { id: "o1", amount: 4_000, description: "data" });
    // books now show an invoice 22 days overdue
    const overdue = [...goodHistory, { id: "INV-9", amount: 40_000, dueDate: day(-22) }];
    (desk as any).deps.books = { source: "standin", invoicesFor: async () => overdue };
    const d = await desk.evaluate("acme");
    expect(d.terms).toBe("PREPAY");
    expect(mandate.pulls.at(-1)!.amount).toBe(4_000);
    expect(state.events.find((e) => e.type === "decision" && e.summary.startsWith("PREPAY"))).toBeTruthy();
  });

  it("revoked mandate: pull refused, debt escalated to a person", async () => {
    const { desk, mandate, state } = setup();
    await desk.placeOrder("acme", { id: "o1", amount: 4_000, description: "data" });
    mandate.revoked = true;
    const d = await desk.evaluate("acme");
    expect(d.escalate).toBe(4_000);
    expect(mandate.pulls).toHaveLength(0); // engine knows a revoked mandate can't be pulled
    expect(state.events.at(-1)!.type).toBe("escalate");
  });

  it("credit note on an open order reduces what the next pull collects", async () => {
    const { desk, mandate } = setup();
    await desk.placeOrder("acme", { id: "o1", amount: 160, description: "40 queries", priceRoute: "/v2/query", unitPrice: 4, units: 40, staleUnits: 7 });
    expect(desk.applyCredit("acme", "o1", 28, "7 stale rows")).toBe(28);
    mandate.budget = 1_000;
    await desk.evaluate("acme");
    expect(mandate.pulls.at(-1)!.amount).toBe(132);
  });

  it("credit on an already-collected order is netted off the next collection", async () => {
    const { desk, mandate, state } = setup();
    await desk.placeOrder("acme", { id: "o1", amount: 160, description: "q", unitPrice: 4, units: 40, staleUnits: 7 });
    mandate.budget = 1_000;
    await desk.evaluate("acme"); // collects 160
    desk.applyCredit("acme", "o1", 28, "stale");
    expect(state.buyers.acme!.creditBalance).toBe(28);
    await desk.placeOrder("acme", { id: "o2", amount: 100, description: "q" });
    mandate.budget = 900; // tighten again → collect all
    await desk.evaluate("acme");
    expect(mandate.pulls.at(-1)!.amount).toBe(72);
    expect(state.buyers.acme!.creditBalance).toBe(0);
  });

  it("a credit note can never exceed what was charged", async () => {
    const { desk } = setup();
    await desk.placeOrder("acme", { id: "o1", amount: 50, description: "q" });
    expect(desk.applyCredit("acme", "o1", 80, "x")).toBe(50);
    expect(desk.applyCredit("acme", "o1", 10, "x")).toBe(0);
  });

  it("resolveDispute applies only the code-decided credits and logs upheld claims", async () => {
    const { desk, state } = setup();
    await desk.placeOrder("acme", { id: "o1", amount: 160, description: "q", priceRoute: "/v2/query", unitPrice: 4, units: 40, staleUnits: 7 });
    const { decideDispute } = await import("../src/disputes/decide.js");
    const decision = decideDispute(
      [
        { type: "price_not_agreed", orderIds: ["o1"], quote: "never agreed to 4c" },
        { type: "data_quality", orderIds: ["o1"], units: 40, quote: "all stale" },
      ],
      desk.evidenceFor("acme"),
    );
    desk.resolveDispute("acme", decision, { summary: "s" });
    expect(state.buyers.acme!.orders[0]!.credited).toBe(28);
    expect(state.events.find((e) => e.type === "dispute")!.summary).toMatch(/\$0\.28 credited, 1 claim\(s\) upheld/);
  });

  it("re-running a collection for the same orders pays at most once", async () => {
    const { desk, mandate } = setup();
    await desk.placeOrder("acme", { id: "o1", amount: 4_000, description: "data" });
    mandate.budget = 10_000;
    await desk.evaluate("acme");
    const spentAfterFirst = mandate.spent;
    // simulate a crash before the desk recorded the collection
    (desk.state.buyers.acme!.orders[0] as any).collectedBy = undefined;
    desk.state.buyers.acme!.previous = { terms: "NET_30", limit: 90_000 };
    await desk.evaluate("acme");
    expect(mandate.spent).toBe(spentAfterFirst);
    expect(desk.state.events.at(-1)!.summary).toMatch(/already paid earlier/);
  });
});
