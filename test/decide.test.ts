import { describe, expect, it } from "vitest";
import { type Claim, decideDispute, type OrderEvidence } from "../src/disputes/decide.js";

const orders = new Map<string, OrderEvidence>([
  ["o1", { id: "o1", priceRoute: "/v2/query", unitPrice: 4, units: 40, staleUnits: 7, proof: "order o1 · signed offer tx 0xabc", credited: 0 }],
  ["o2", { id: "o2", priceRoute: "/v2/query", unitPrice: 4, units: 20, staleUnits: 0, proof: "order o2", credited: 0 }],
]);

describe("decideDispute", () => {
  it("'never agreed to 4¢': upheld with the order's proof, no credit", () => {
    const claims: Claim[] = [{ type: "price_not_agreed", orderIds: ["o1"], quote: "our agent never agreed to 4 cents" }];
    const d = decideDispute(claims, orders);
    expect(d.totalCredit).toBe(0);
    expect(d.findings[0]).toMatchObject({ verdict: "upheld_for_supplier", proof: expect.stringContaining("0xabc") });
  });

  it("'data was stale, refund all 40': credits only the 7 units QA flagged", () => {
    const d = decideDispute([{ type: "data_quality", orderIds: ["o1"], units: 40, quote: "all 40 rows were stale" }], orders);
    expect(d.totalCredit).toBe(28);
    expect(d.findings[0]).toMatchObject({ verdict: "credit", amount: 28 });
  });

  it("customer claims fewer stale units than QA found: credit what they claimed", () => {
    expect(decideDispute([{ type: "data_quality", orderIds: ["o1"], units: 3, quote: "3 rows wrong" }], orders).totalCredit).toBe(12);
  });

  it("no stale units on record: no credit", () => {
    expect(decideDispute([{ type: "data_quality", orderIds: ["o2"], quote: "bad data" }], orders).findings[0]).toMatchObject({ verdict: "upheld_for_supplier" });
  });

  it("the same claim twice never credits twice", () => {
    const c: Claim = { type: "data_quality", orderIds: ["o1"], quote: "stale" };
    expect(decideDispute([c, c], orders).totalCredit).toBe(28);
  });

  it("unknown orders and vague complaints go to a person", () => {
    const d = decideDispute([{ type: "data_quality", orderIds: ["nope"], quote: "x" }, { type: "other", orderIds: [], quote: "your service is bad" }], orders);
    expect(d.findings.map((f) => f.verdict)).toEqual(["escalate", "escalate"]);
  });
});
