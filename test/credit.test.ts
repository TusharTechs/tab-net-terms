import { describe, expect, it } from "vitest";
import { type BuyerSnapshot, evaluateCredit, routeOrder, VIC_MAX_PER_TXN } from "../src/domain/credit.js";
import { fromMajor, toMajor } from "../src/domain/money.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const SUPPLIER = "0xSupplier";

/** A buyer with a good record: usable $900 mandate, 3 on-time invoices, one VIC payment. */
function goodBuyer(overrides: Partial<BuyerSnapshot> = {}): BuyerSnapshot {
  return {
    buyerId: "acme-agent",
    supplierPayee: SUPPLIER,
    mandate: { payees: [SUPPLIER], budget: 90_000, spent: 0, revoked: false, expiresAt: day(30) },
    onchainBalance: 500_000,
    invoices: [
      { id: "INV-1", amount: 10_000, dueDate: day(-60), paidAt: day(-61) },
      { id: "INV-2", amount: 12_000, dueDate: day(-40), paidAt: day(-40) },
      { id: "INV-3", amount: 9_000, dueDate: day(-20), paidAt: day(-21) },
    ],
    vicSettledCount: 1,
    outstanding: 0,
    ...overrides,
  };
}
const codes = (d: { reasons: { code: string }[] }) => d.reasons.map((r) => r.code);

describe("money", () => {
  it("converts major units without float drift and refuses sub-cent amounts", () => {
    expect(fromMajor("12.34")).toBe(1234);
    expect(fromMajor(0.1 + 0.2)).toBe(30);
    expect(toMajor(1234)).toBe("12.34");
    expect(toMajor(5)).toBe("0.05");
    expect(() => fromMajor("1.005")).toThrow(/sub-cent/);
  });
});

describe("evaluateCredit", () => {
  it("gives net-30 up to the cap to a buyer with a good record", () => {
    const d = evaluateCredit(goodBuyer(), NOW);
    expect(d.terms).toBe("NET_30");
    expect(d.limit).toBe(90_000);
    expect(d.available).toBe(90_000);
    expect(codes(d)).toContain("NET_30_EARNED");
  });

  it("hook beat: human cuts mandate $900 → $250, tab drops and $180 is collected at once", () => {
    const before = evaluateCredit(goodBuyer({ outstanding: 18_000 }), NOW);
    expect(before.limit).toBe(90_000);
    expect(before.collectNow).toBe(0);

    const after = evaluateCredit(
      goodBuyer({ outstanding: 18_000, mandate: { payees: [SUPPLIER], budget: 25_000, spent: 0, revoked: false } }),
      NOW,
      undefined,
      { terms: before.terms, limit: before.limit },
    );
    expect(after.limit).toBe(25_000);
    expect(codes(after)).toEqual(expect.arrayContaining(["LIMIT_BY_MANDATE_HEADROOM", "LIMIT_TIGHTENED", "COLLECT_ALL"]));
    expect(after.collectNow).toBe(18_000);
    expect(after.escalate).toBe(0);
  });

  it("T:0 shows an invoice 22 days overdue → prepay only and everything outstanding is collected", () => {
    const d = evaluateCredit(
      goodBuyer({ outstanding: 5_000, invoices: [...goodBuyer().invoices, { id: "INV-9", amount: 40_000, dueDate: day(-22) }] }),
      NOW,
      undefined,
      { terms: "NET_30", limit: 90_000 },
    );
    expect(d.terms).toBe("PREPAY");
    expect(d.limit).toBe(0);
    expect(d.reasons.find((r) => r.code === "OVERDUE_INVOICE")?.detail).toMatch(/INV-9 is 22 days overdue/);
    expect(codes(d)).toContain("DEMOTED_TO_PREPAY");
    expect(d.collectNow).toBe(5_000);
  });

  it("an invoice inside the grace period does not demote", () => {
    const d = evaluateCredit(goodBuyer({ invoices: [...goodBuyer().invoices, { id: "INV-10", amount: 1_000, dueDate: day(-2) }] }), NOW);
    expect(d.terms).toBe("NET_30");
  });

  it("no settled VIC payment yet → prepay, even with a mandate", () => {
    const d = evaluateCredit(goodBuyer({ vicSettledCount: 0 }), NOW);
    expect(d.terms).toBe("PREPAY");
    expect(codes(d)).toContain("NO_VIC_HISTORY");
  });

  it("thin history gets net-7 and the net-7 cap", () => {
    const d = evaluateCredit(goodBuyer({ invoices: [] }), NOW);
    expect(d.terms).toBe("NET_7");
    expect(d.limit).toBe(30_000);
  });

  it("buyer's on-chain balance caps the limit", () => {
    const d = evaluateCredit(goodBuyer({ onchainBalance: 12_345 }), NOW);
    expect(d.limit).toBe(12_345);
    expect(codes(d)).toContain("LIMIT_BY_ONCHAIN_BALANCE");
  });

  it("revoked mandate → nothing can be pulled; the whole balance is escalated", () => {
    const d = evaluateCredit(
      goodBuyer({ outstanding: 7_000, mandate: { payees: [SUPPLIER], budget: 90_000, spent: 0, revoked: true } }),
      NOW,
      undefined,
      { terms: "NET_30", limit: 90_000 },
    );
    expect(d.terms).toBe("PREPAY");
    expect(d.collectNow).toBe(0);
    expect(d.escalate).toBe(7_000);
    expect(codes(d)).toContain("ESCALATE_UNCOLLECTABLE");
  });

  it("owing more than the mandate can cover → pull what it can, escalate the rest", () => {
    const d = evaluateCredit(
      goodBuyer({ outstanding: 30_000, mandate: { payees: [SUPPLIER], budget: 20_000, spent: 0, revoked: false } }),
      NOW,
      undefined,
      { terms: "NET_30", limit: 90_000 },
    );
    expect(d.collectNow).toBe(20_000);
    expect(d.escalate).toBe(10_000);
  });

  it("a mandate that doesn't name the supplier gives no credit", () => {
    const d = evaluateCredit(goodBuyer({ mandate: { payees: ["0xSomeoneElse"], budget: 90_000, spent: 0, revoked: false } }), NOW);
    expect(d.terms).toBe("PREPAY");
    expect(codes(d)).toContain("SUPPLIER_NOT_PAYEE");
  });

  it("an expired mandate gives no credit", () => {
    const d = evaluateCredit(goodBuyer({ mandate: { payees: [SUPPLIER], budget: 90_000, spent: 0, revoked: false, expiresAt: day(-1) } }), NOW);
    expect(codes(d)).toContain("MANDATE_EXPIRED");
  });

  it("is deterministic", () => {
    expect(evaluateCredit(goodBuyer({ outstanding: 1 }), NOW)).toEqual(evaluateCredit(goodBuyer({ outstanding: 1 }), NOW));
  });
});

describe("routeOrder", () => {
  it("puts an order on the tab only if it fits what's available", () => {
    const d = evaluateCredit(goodBuyer({ outstanding: 80_000 }), NOW);
    expect(routeOrder(d, 10_000)).toEqual({ kind: "ON_TAB" });
    expect(routeOrder(d, 10_001)).toEqual({ kind: "PREPAY_VIC" });
  });

  it("never splits: prepay orders over $200 go to an invoice, not several VIC payments", () => {
    const d = evaluateCredit(goodBuyer({ vicSettledCount: 0 }), NOW);
    expect(routeOrder(d, VIC_MAX_PER_TXN)).toEqual({ kind: "PREPAY_VIC" });
    expect(routeOrder(d, VIC_MAX_PER_TXN + 1)).toEqual({ kind: "PREPAY_INVOICE", reason: "OVER_VIC_CAP" });
  });
});
