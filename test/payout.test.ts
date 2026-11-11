import { describe, expect, it } from "vitest";
import { type AirwallexClient, AirwallexError } from "../src/airwallex/client.js";
import type { DeskState } from "../src/desk/desk.js";
import { decidePayouts, paidOnAirwallex, paidOnAirwallexReason, payoutRequestId, payoutsOf, payVendorBill, provenSgdOf, type VendorBill } from "../src/payout/vendor.js";
import { checkBooks, checkLive } from "../src/proof/checker.js";

const bill = (id: string, amount: number, due: string): VendorBill => ({ id, number: `INV-${id}`, vendorId: `v-${id}`, vendorName: `Vendor ${id}`, currency: "USD", amount, dueDate: due });

describe("which vendor bills the desk pays", () => {
  const bills = [bill("big", 1_000_000, "2026-03-31"), bill("small", 10_000, "2026-03-16"), bill("mid", 500_000, "2026-03-20")];
  const costs = new Map([["big", 1_290_000], ["small", 12_900], ["mid", 645_000]]);

  it("pays the oldest bill that proven money covers; sends the rest to a person, with the reason", () => {
    const d = decidePayouts(bills, costs, { provenSgd: 35_168, spentSgd: 0, paidBillIds: new Set() });
    expect(d.map((x) => [x.bill.id, x.verdict])).toEqual([["small", "pay"], ["mid", "person"], ["big", "person"]]);
    expect(d[1]!.reason).toMatch(/over the SGD 1000.00 per-bill limit/);
  });

  it("keeps the floor back: a bill that would eat into it goes to a person", () => {
    const d = decidePayouts([bill("small", 10_000, "2026-03-16")], costs, { provenSgd: 15_000, spentSgd: 0, paidBillIds: new Set() });
    expect(d[0]).toMatchObject({ verdict: "person", reason: expect.stringMatching(/more than proven money covers \(SGD 100.00 left after the SGD 50.00 floor\)/) });
  });

  it("never pays a bill twice", () => {
    const d = decidePayouts([bill("small", 10_000, "2026-03-16")], costs, { provenSgd: 35_168, spentSgd: 12_900, paidBillIds: new Set(["small"]) });
    expect(d[0]).toMatchObject({ verdict: "already_paid" });
  });

  it("reads proven SGD and past payouts from the desk log", () => {
    const state = { buyers: {}, events: [
      { seq: 1, at: "", buyerId: "acme", type: "settle", summary: "deposited $186.24 …, converted 176.92 USD → 225.47 SGD", data: { conversionId: "c1" } },
      { seq: 2, at: "", buyerId: "acme", type: "settle", summary: "x", data: { conversionId: "c2", sgdCents: 2_935 } },
      { seq: 3, at: "", buyerId: "desk", type: "payout", summary: "paid", data: { billId: "small", sgdCents: 12_900 } },
    ] } as unknown as DeskState;
    expect(provenSgdOf(state)).toBe(22_547 + 2_935);
    expect(payoutsOf(state)).toEqual({ spentSgd: 12_900, paidBillIds: new Set(["small"]) });
  });
});

function fakeAwx(existing: { id: string; request_id: string; status: string; source_amount: number; transfer_amount: number }[] = [], opts: { duplicateOnCreate?: boolean } = {}) {
  const calls: string[] = [];
  const transfers = [...existing];
  const awx = {
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      const rid = /request_id=([^&]+)/.exec(path)?.[1];
      if (rid) return { items: transfers.filter((t) => t.request_id === decodeURIComponent(rid)) };
      if (path.startsWith("/transfers?page_num=")) return { items: transfers };
      const id = path.split("/").at(-1);
      return transfers.find((t) => t.id === id);
    },
    post: async (path: string, body: any) => {
      calls.push(`POST ${path}`);
      if (path === "/transfers/create") {
        const t = { id: "t-new", request_id: body.request_id, status: "SCHEDULED", source_amount: 129.01, transfer_amount: body.transfer_amount, short_reference_id: "P1" };
        transfers.push(t);
        if (opts.duplicateOnCreate) throw new AirwallexError(400, "duplicate_request_id", "dup", undefined, path);
        return t;
      }
      const m = /\/simulation\/transfers\/(.+)\/transition/.exec(path);
      if (m) { const t = transfers.find((x) => x.id === m[1])!; t.status = body.next_status; return t; }
      return {};
    },
  } as unknown as AirwallexClient;
  return { awx, calls };
}

describe("paying a bill on Airwallex", () => {
  const b = bill("small", 10_000, "2026-03-16");

  it("asks Airwallex for the bill's request id first; sends one transfer, moves it to PAID, reads it back", async () => {
    const { awx, calls } = fakeAwx();
    const r = await payVendorBill(awx, { bill: b, beneficiaryId: "ben", requestId: "tab-r1-small", simulate: true });
    expect(r).toMatchObject({ transferId: "t-new", status: "PAID", sgdCents: 12_901, paidCents: 10_000, alreadyDone: false });
    expect(calls).toEqual(["GET /transfers?request_id=tab-r1-small", "GET /transfers?page_num=0&page_size=100", "POST /transfers/create", "POST /simulation/transfers/t-new/transition", "POST /simulation/transfers/t-new/transition", "GET /transfers/t-new"]);
  });

  it("a second attempt finds the first transfer and sends nothing", async () => {
    const { awx, calls } = fakeAwx([{ id: "t-old", request_id: "tab-r1-small", status: "PAID", source_amount: 129.01, transfer_amount: 100 }]);
    const r = await payVendorBill(awx, { bill: b, beneficiaryId: "ben", requestId: "tab-r1-small", simulate: true });
    expect(r).toMatchObject({ transferId: "t-old", alreadyDone: true });
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("a lost response on create is resolved by looking the request id up again", async () => {
    const { awx } = fakeAwx([], { duplicateOnCreate: true });
    const r = await payVendorBill(awx, { bill: b, beneficiaryId: "ben", requestId: "tab-r1-small", simulate: false });
    expect(r).toMatchObject({ transferId: "t-new", alreadyDone: true });
  });
});

describe("paying a bill on Airwallex, across runs", () => {
  const b = bill("small", 10_000, "2026-03-16");
  const paid = { id: "t-old", request_id: "tab-an-earlier-run-small", status: "PAID", source_amount: 129.01, transfer_amount: 100, reference: "INV-small", beneficiary_id: "ben", transfer_currency: "USD" };

  it("the request id names only the bill, so every run asks Airwallex for the same one", () => {
    expect(payoutRequestId(b)).toBe("tab-bill-small");
  });

  it("a live transfer of the same bill number, amount and payee under another request id counts as paid", async () => {
    const { awx, calls } = fakeAwx([paid]);
    const r = await payVendorBill(awx, { bill: b, beneficiaryId: "ben", requestId: payoutRequestId(b), simulate: true });
    expect(r).toMatchObject({ transferId: "t-old", alreadyDone: true });
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("before deciding, bills Airwallex already paid are found, and their money is not set aside again", async () => {
    const other = bill("next", 15_000, "2026-11-04");
    const { awx } = fakeAwx([paid]);
    const onAwx = await paidOnAirwallex(awx, [b, other], { "v-small": "ben", "v-next": "ben" });
    expect([...onAwx.keys()]).toEqual(["small"]);
    const costs = new Map([["small", 12_900], ["next", 19_300]]);
    const reasons = new Map([...onAwx].map(([id, t]) => [id, paidOnAirwallexReason(t)]));
    const d = decidePayouts([b, other], costs, { provenSgd: 30_000, spentSgd: 0, paidBillIds: new Set(onAwx.keys()), paidReasons: reasons });
    expect(d.map((x) => x.verdict)).toEqual(["already_paid", "pay"]);
    expect(d[0]!.reason).toMatch(/already paid by Airwallex transfer t-old \(PAID\); T:0 still shows the bill open/);
  });

  it("a vendor with no bank details on file is never matched", async () => {
    const { awx } = fakeAwx([paid]);
    expect((await paidOnAirwallex(awx, [b], {})).size).toBe(0);
  });

  it("a failed transfer, another payee or another amount does not count: the bill is paid", async () => {
    for (const other of [{ ...paid, status: "FAILED" }, { ...paid, beneficiary_id: "someone-else" }, { ...paid, transfer_amount: 99 }]) {
      const { awx } = fakeAwx([other]);
      const r = await payVendorBill(awx, { bill: b, beneficiaryId: "ben", requestId: payoutRequestId(b), simulate: false });
      expect(r.alreadyDone).toBe(false);
    }
  });
});

describe("payout proof", () => {
  const base = (payouts: { billId: string; sgdCents: number }[]): DeskState => ({
    buyers: {},
    events: [
      { seq: 1, at: "", buyerId: "acme", type: "settle", summary: "converted 199.73 USD → 254.10 SGD", data: { conversionId: "c1" } },
      ...payouts.map((p, i) => ({ seq: 2 + i, at: "", buyerId: "desk", type: "payout" as const, summary: "paid", data: { ...p, billNumber: `INV-${p.billId}`, amount: 10_000, currency: "USD", transferId: `t${i}` } })),
    ],
  });
  it("flags a bill paid twice and spending beyond proven money", () => {
    const ok = checkBooks(base([{ billId: "a", sgdCents: 12_900 }]));
    expect(ok.filter((c) => c.name.startsWith("vendor")).every((c) => c.ok)).toBe(true);
    const bad = checkBooks(base([{ billId: "a", sgdCents: 12_900 }, { billId: "a", sgdCents: 15_000 }]));
    expect(bad.find((c) => c.name === "vendor bills: each paid once")!.ok).toBe(false);
    const over = checkBooks(base([{ billId: "a", sgdCents: 30_000 }]));
    expect(over.find((c) => c.name === "vendor payouts spent only proven money")!.ok).toBe(false);
  });
  it("live: the transfer must be PAID, for the bill, spending the SGD recorded", async () => {
    const state = base([{ billId: "a", sgdCents: 12_900 }]);
    const run = (t: { status: string; source_amount: number; transfer_amount: number }) => checkLive(state, { receiptStatus: async () => "0x1", transfer: async () => t });
    expect((await run({ status: "PAID", source_amount: 129, transfer_amount: 100 })).find((c) => c.name.startsWith("vendor payout"))!.ok).toBe(true);
    expect((await run({ status: "SENT", source_amount: 129, transfer_amount: 100 })).find((c) => c.name.startsWith("vendor payout"))!.ok).toBe(false);
    expect((await run({ status: "PAID", source_amount: 129, transfer_amount: 99 })).find((c) => c.name.startsWith("vendor payout"))!.ok).toBe(false);
  });
});
