import { describe, expect, it } from "vitest";
import { type AirwallexClient, AirwallexError } from "../src/airwallex/client.js";
import { InMemoryLedger } from "../src/ledger/settlements.js";
import { type ConversionApprovalRequest, DEFAULT_SETTLEMENT_POLICY, settleCollection } from "../src/settlement/bridge.js";

const NOW = new Date("2026-11-09T10:00:00Z");
const clock = () => NOW;

interface FakeOpts {
  validTo?: string;
  belowMin?: boolean;
  /** Existing deposits returned by GET /deposits. */
  deposits?: { id: string; reference: string }[];
  conversionError?: AirwallexError;
}

function fakeAwx(opts: FakeOpts = {}) {
  const calls: { path: string; body: any }[] = [];
  let depositSeq = 0;
  const awx = {
    async get(path: string) {
      calls.push({ path, body: undefined });
      if (path === "/deposits") return { items: opts.deposits ?? [] };
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: string, body: any) {
      calls.push({ path, body });
      if (path === "/simulation/deposit/create") return { id: `dep_${++depositSeq}`, status: "SETTLED", amount: body.amount, currency: "USD" };
      if (path === "/fx/quotes/create") {
        if (opts.belowMin) throw new AirwallexError(400, "validation_error", "amount_below_limit", "t", path);
        return { quote_id: "q_1", client_rate: 1.27, sell_amount: body.sell_amount, buy_amount: +(body.sell_amount * 1.27).toFixed(2), sell_currency: "USD", buy_currency: "SGD", valid_to_at: opts.validTo ?? "2026-11-09T10:15:00Z" };
      }
      if (path === "/fx/conversions/create") {
        if (opts.conversionError) throw opts.conversionError;
        return { conversion_id: "conv_1", status: "SETTLED" };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  } as unknown as AirwallexClient;
  const count = (p: string) => calls.filter((c) => c.path === p).length;
  return { awx, calls, count };
}

const collection = { metalTxHash: "0xAbC", amount: 250, payerName: "Acme buyer agent" };
const never = async () => {
  throw new Error("approver should not be called");
};
const settle = (awx: AirwallexClient, ledger: InMemoryLedger, c = collection, approve: any = never) =>
  settleCollection(awx, ledger, "ga_1", c, approve, DEFAULT_SETTLEMENT_POLICY, clock);

describe("settleCollection", () => {
  it("deposits with the Metal tx hash as reference, keeps a 5% reserve rounded up, converts the rest", async () => {
    const { awx, calls } = fakeAwx();
    const ledger = new InMemoryLedger();
    const out = await settle(awx, ledger);
    expect(calls[0]!.body).toMatchObject({ global_account_id: "ga_1", amount: 2.5, reference: "Metal USDZ collection 0xAbC" });
    expect(out.kind).toBe("converted");
    if (out.kind !== "converted") return;
    expect(out.reserved).toBe(13); // 5% of 250 = 12.5 → 13
    expect(calls.at(-1)!.body).toMatchObject({ quote_id: "q_1", sell_amount: "2.37" });
    expect(ledger.get("0xabc")).toMatchObject({ state: "converted", depositId: "dep_1", conversionId: "conv_1" });
  });

  it("a second run for the same tx hash moves no money (ledger check, case-insensitive)", async () => {
    const { awx, count } = fakeAwx();
    const ledger = new InMemoryLedger();
    await settle(awx, ledger);
    const again = await settle(awx, ledger, { ...collection, metalTxHash: "0xabc" });
    expect(again.kind).toBe("already_settled");
    expect(count("/simulation/deposit/create")).toBe(1);
    expect(count("/fx/conversions/create")).toBe(1);
  });

  it("crash after marking deposit_pending: finds the existing deposit instead of depositing again", async () => {
    const { awx, count } = fakeAwx({ deposits: [{ id: "dep_existing", reference: "Metal USDZ collection 0xAbC" }] });
    const ledger = new InMemoryLedger();
    ledger.put({ metalTxHash: "0xAbC", amount: 250, updatedAt: NOW.toISOString(), state: "deposit_pending" });
    const out = await settle(awx, ledger);
    expect(count("/simulation/deposit/create")).toBe(0);
    expect(out.kind === "converted" && out.depositId).toBe("dep_existing");
  });

  it("crash after marking converting: retries with the same request_id; a duplicate means it was booked", async () => {
    const { awx, calls } = fakeAwx({ conversionError: new AirwallexError(400, "duplicate_request_id", "dup", "t", "/fx/conversions/create") });
    const ledger = new InMemoryLedger();
    ledger.put({ metalTxHash: "0xAbC", amount: 250, updatedAt: NOW.toISOString(), state: "converting", depositId: "dep_1", quoteId: "q_1", requestId: "req-saved" });
    const out = await settle(awx, ledger);
    expect(calls.map((c) => c.path)).toEqual(["/fx/conversions/create"]);
    expect(calls[0]!.body.request_id).toBe("req-saved");
    expect(out.kind).toBe("already_settled");
    expect(ledger.get("0xabc")).toMatchObject({ state: "converted", requestId: "req-saved" });
  });

  it("asks a person above the threshold, with the exact quote, and books that quote", async () => {
    const { awx, calls } = fakeAwx();
    let seen: ConversionApprovalRequest | undefined;
    const out = await settle(awx, new InMemoryLedger(), { ...collection, amount: 500_000 }, async (r: ConversionApprovalRequest) => ((seen = r), true));
    expect(seen?.quoteId).toBe("q_1");
    expect(out.kind === "converted" && out.approvedBy).toBe("person");
    expect(calls.at(-1)!.body.quote_id).toBe("q_1");
  });

  it("declined approval: money stays in USD, ledger says why", async () => {
    const { awx, count } = fakeAwx();
    const ledger = new InMemoryLedger();
    const out = await settle(awx, ledger, { ...collection, amount: 500_000 }, async () => false);
    expect(out).toMatchObject({ kind: "deposited_only", reason: "approval_declined" });
    expect(count("/fx/conversions/create")).toBe(0);
    expect(ledger.get("0xabc")).toMatchObject({ state: "held_usd", reason: "approval_declined" });
  });

  it("an expired quote is never booked", async () => {
    const { awx, count } = fakeAwx({ validTo: "2026-11-09T09:59:00Z" });
    const out = await settle(awx, new InMemoryLedger());
    expect(out).toMatchObject({ kind: "deposited_only", reason: "quote_expired" });
    expect(count("/fx/conversions/create")).toBe(0);
  });

  it("below Airwallex's FX minimum: deposit stays in USD for a later sweep", async () => {
    const { awx, count } = fakeAwx({ belowMin: true });
    const out = await settle(awx, new InMemoryLedger(), { ...collection, amount: 70 });
    expect(out).toMatchObject({ kind: "deposited_only", reason: "below_fx_minimum", depositId: "dep_1" });
    expect(count("/fx/conversions/create")).toBe(0);
  });
});
