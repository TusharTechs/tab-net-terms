import { describe, expect, it } from "vitest";
import type { CreditDecision } from "../src/domain/credit.js";
import { checkBuyerPolicy, discountYield, quote } from "../src/terms/offers.js";

const decision = (over: Partial<CreditDecision> = {}): CreditDecision => ({ buyerId: "acme", terms: "NET_30", limit: 50_000, available: 50_000, collectNow: 0, escalate: 0, reasons: [], ...over });

describe("offers", () => {
  it("2/10 net 30 is worth ~37% a year", () => {
    expect(discountYield(0.02, 10, 30)).toBeCloseTo(0.3724, 3);
  });

  it("a buyer with terms gets card, net-30 and the early-pay discount", () => {
    const o = quote("fx-backfill", 10, decision());
    expect(o.listAmount).toBe(12_000);
    expect(o.options.map((x) => x.option)).toEqual(["prepay_card", "net_30", "pay_in_10_discount"]);
    expect(o.options.find((x) => x.option === "pay_in_10_discount")!.amount).toBe(11_760);
  });

  it("over $200 there is no card option (never split)", () => {
    const o = quote("sla-day", 9, decision());
    expect(o.listAmount).toBe(22_500);
    expect(o.options.map((x) => x.option)).toEqual(["net_30", "pay_in_10_discount"]);
    expect(o.notes.join(" ")).toMatch(/over the \$200/);
  });

  it("terms must fit available credit; the card still works under $200", () => {
    const o = quote("sla-day", 7, decision({ available: 10_000 }));
    expect(o.listAmount).toBe(17_500);
    expect(o.options.map((x) => x.option)).toEqual(["prepay_card"]);
    expect(o.notes.join(" ")).toMatch(/over available credit/);
  });

  it("a prepay-only buyer sees only the card, with the reason", () => {
    const o = quote("mkt-queries", 1_000, decision({ terms: "PREPAY", available: 0, reasons: [{ code: "OVERDUE_INVOICE", detail: "INV-2002 is 22 days overdue" }] }));
    expect(o.options.map((x) => x.option)).toEqual(["prepay_card"]);
    expect(o.notes[0]).toMatch(/22 days overdue/);
  });

  it("rejects silly quantities", () => {
    expect(() => quote("sla-day", 0, decision())).toThrow();
    expect(() => quote("sla-day", 1.5, decision())).toThrow();
    expect(() => quote("nope", 1, decision())).toThrow();
  });

  it("buyer policy blocks orders over its own limits", () => {
    const pol = { maxOrder: 15_000, monthlyBudget: 30_000, costOfCapital: 0.12 };
    expect(checkBuyerPolicy(pol, 0, 16_000)).toMatch(/max order/);
    expect(checkBuyerPolicy(pol, 20_000, 12_000)).toMatch(/monthly budget/);
    expect(checkBuyerPolicy(pol, 0, 12_000)).toBeNull();
  });
});

describe("net-7 buyers", () => {
  it("get a 7-day tab option only: no net-30, no early-pay discount", () => {
    const o = quote("sla-day", 2, decision({ terms: "NET_7", limit: 30_000, available: 30_000 }));
    expect(o.options.map((x) => [x.option, x.dueInDays])).toEqual([["prepay_card", 0], ["net_7", 7]]);
  });
});
