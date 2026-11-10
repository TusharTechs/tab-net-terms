import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Books } from "../src/books/books.js";
import { Desk, type DeskState } from "../src/desk/desk.js";
import type { MandateStatus, PullOutcome } from "../src/metal/agent.js";
import { applyRails, DEFAULT_DESK_POLICY, type PolicyProposal, signPolicy, verifyPolicy } from "../src/policy/policy.js";

const none = { net7LimitUsd: null, net30LimitUsd: null, net30MinOnTimeInvoices: null, net30MinOnTimeRatePct: null, graceDays: null, earlyPayDiscountPct: null, earlyPayDays: null };
const proposal = (changes: Partial<PolicyProposal["changes"]>, notCompiled: PolicyProposal["notCompiled"] = []): PolicyProposal => ({ changes: { ...none, ...changes }, because: [], notCompiled, summary: "" });

function keys() {
  const dir = mkdtempSync(join(tmpdir(), "tab-policy-"));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const priv = join(dir, "issuer.json");
  const pub = join(dir, "issuer.public.json");
  writeFileSync(priv, JSON.stringify({ kid: "k1", privateJwk: privateKey.export({ format: "jwk" }) }));
  writeFileSync(pub, JSON.stringify({ kid: "k1", jwk: publicKey.export({ format: "jwk" }) }));
  return { priv, pub };
}

describe("CFO policy: code decides", () => {
  it("accepts changes inside the rails and rejects (never clamps) ones outside", () => {
    const r = applyRails(DEFAULT_DESK_POLICY, proposal({ net30LimitUsd: 350, earlyPayDiscountPct: 3, net7LimitUsd: 5_000 }));
    expect(r.policy.credit.net30Limit).toBe(35_000);
    expect(r.policy.terms.earlyPay.discount).toBe(0.03);
    expect(r.policy.credit.net7Limit).toBe(DEFAULT_DESK_POLICY.credit.net7Limit);
    expect(r.rejected).toEqual([expect.objectContaining({ field: "net7Limit", to: 500_000, why: expect.stringMatching(/outside the rail/) })]);
    // The model cannot reach these at all.
    expect(r.policy.credit.requireVicBeforeCredit).toBe(true);
    expect(r.policy.credit.collectAllOnTightening).toBe(true);
  });

  it("never lets net-7 exceed net-30", () => {
    const r = applyRails(DEFAULT_DESK_POLICY, proposal({ net30LimitUsd: 200 }));
    expect(r.policy.credit.net30Limit).toBe(DEFAULT_DESK_POLICY.credit.net30Limit);
    expect(r.rejected[0]).toMatchObject({ field: "net30Limit", why: /net-7 limit would exceed/ });
  });

  it("a signed policy verifies; a tampered one or a different key does not", () => {
    const k = keys();
    const r = applyRails(DEFAULT_DESK_POLICY, proposal({ earlyPayDiscountPct: 3 }));
    const signed = signPolicy({ policy: r.policy, goals: "faster cash", summary: "", accepted: r.accepted, rejected: r.rejected, notCompiled: [] }, k.priv);
    expect(verifyPolicy(signed, k.pub)).toBe(true);
    const tampered = { ...signed, policy: { ...signed.policy, terms: { earlyPay: { days: 10, discount: 0.05 } } } };
    expect(verifyPolicy(tampered, k.pub)).toBe(false);
    expect(verifyPolicy(signed, keys().pub)).toBe(false);
  });
});

describe("the book re-prices itself", () => {
  function setup() {
    const pulls: number[] = [];
    const metal = {
      status: async (): Promise<MandateStatus> => ({ mandateId: "0x", bound: true, revoked: false, spent: 0, budget: 40_000, payments: 0, capPerPayment: 40_000, payees: ["S"] }),
      pull: async (p: { amount: number }): Promise<PullOutcome> => { pulls.push(p.amount); return { outcome: "paid", tx: `0x${pulls.length}`, alreadyPaid: false, spent: "" }; },
    };
    const NOW = new Date("2026-11-10T00:00:00Z");
    const history = [1, 2, 3].map((i) => ({ id: `I${i}`, amount: 1, dueDate: new Date(NOW.getTime() - i * 864e6), paidAt: new Date(NOW.getTime() - i * 864e6 - 864e5) }));
    const books: Books = { source: "standin", invoicesFor: async () => history };
    const state: DeskState = { buyers: { acme: { id: "acme", name: "Acme", account: "0xA", credential: "c", mandateKeyFile: "k", vicSettledCount: 1, orders: [] } }, events: [] };
    return { desk: new Desk(state, { supplierPayee: "S", metal, balanceOf: async () => 1_000_000, books, now: () => NOW }), state, pulls };
  }

  it("dry run shows the consequence; applying it does exactly that; offers re-price", async () => {
    const { desk, state, pulls } = setup();
    await desk.placeAgentOrder("acme", { productId: "fx-backfill", units: 10, option: "net_30" }); // $120 on the tab, limit $400
    const k = keys();
    const r = applyRails(DEFAULT_DESK_POLICY, proposal({ net30LimitUsd: 350, earlyPayDiscountPct: 3 }));
    const diff = await desk.dryRunPolicy(r.policy);
    expect(diff[0]).toMatchObject({ before: { terms: "NET_30", limit: 40_000 }, after: { terms: "NET_30", limit: 35_000 }, outstanding: 12_000, wouldCollect: 12_000 });
    expect(pulls).toEqual([]); // the dry run moved nothing

    const signed = signPolicy({ policy: r.policy, goals: "g", summary: "", accepted: r.accepted, rejected: r.rejected, notCompiled: [] }, k.priv);
    expect(await desk.applyPolicy(signed, verifyPolicy(signed, k.pub), diff)).toBe(true);
    expect(pulls).toEqual([12_000]); // tightening collected the tab, as the dry run said
    expect(state.events.some((e) => e.type === "policy")).toBe(true);
    const offer = await desk.offerFor("acme", "fx-backfill", 10);
    expect(offer.options.find((o) => o.option === "pay_in_10_discount")).toMatchObject({ amount: 11_640, discount: 0.03 });
  });

  it("an unsigned or forged policy is not applied", async () => {
    const { desk, state } = setup();
    const k = keys();
    const r = applyRails(DEFAULT_DESK_POLICY, proposal({ earlyPayDiscountPct: 5 }));
    const signed = signPolicy({ policy: r.policy, goals: "g", summary: "", accepted: r.accepted, rejected: [], notCompiled: [] }, k.priv);
    expect(await desk.applyPolicy(signed, verifyPolicy(signed, keys().pub), [])).toBe(false);
    expect(state.policy).toBeUndefined();
    expect(desk.salesTerms().earlyPay.discount).toBe(0.02);
  });
});
