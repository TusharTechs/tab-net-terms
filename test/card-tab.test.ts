import { describe, expect, it } from "vitest";
import type { Books } from "../src/books/books.js";
import { Desk, type DeskState } from "../src/desk/desk.js";
import type { CreditDecision } from "../src/domain/credit.js";
import type { MandateStatus, PullOutcome } from "../src/metal/agent.js";
import { checkBooks, checkLive } from "../src/proof/checker.js";
import { quote } from "../src/terms/offers.js";

const NOW = new Date("2026-11-10T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const history = [1, 2, 3].map((i) => ({ id: `I${i}`, amount: 1, dueDate: day(-10 * i), paidAt: day(-10 * i - 1) }));
const prepay = (reasons: CreditDecision["reasons"]): CreditDecision => ({ buyerId: "g", terms: "PREPAY", limit: 0, available: 0, collectNow: 0, escalate: 0, reasons });

describe("card-secured tab offer", () => {
  it("a buyer with no terms yet (nothing overdue) can pay later on a card-secured 7-day tab", () => {
    const o = quote("fx-backfill", 5, prepay([{ code: "NO_VIC_HISTORY", detail: "no settled VIC payment yet" }]));
    expect(o.options.map((x) => [x.option, x.dueInDays])).toEqual([["prepay_card", 0], ["card_net_7", 7]]);
  });
  it("is not offered to a buyer with an overdue invoice, or over the $200 card cap", () => {
    expect(quote("fx-backfill", 5, prepay([{ code: "OVERDUE_INVOICE", detail: "INV-1 overdue" }])).options.map((x) => x.option)).toEqual(["prepay_card"]);
    expect(quote("sla-day", 9, prepay([{ code: "NO_VIC_HISTORY", detail: "" }])).options).toEqual([]);
  });
});

function setup() {
  const pis = new Map<string, { status: string; amount: number; captured_amount?: number; merchant_order_id: string; metadata: Record<string, string> }>();
  const pulls: number[] = [];
  const metal = {
    status: async (): Promise<MandateStatus> => ({ mandateId: "0x", bound: true, revoked: false, spent: 0, budget: 9_000, payments: 0, capPerPayment: 9_000, payees: ["S"] }),
    pull: async (p: { amount: number }): Promise<PullOutcome> => { pulls.push(p.amount); return { outcome: "paid", tx: "0xtx", alreadyPaid: false, spent: "" }; },
  };
  const books: Books = { source: "standin", invoicesFor: async () => history };
  const state: DeskState = { buyers: { globex: { id: "globex", name: "G", account: "0xG", credential: "c", mandateKeyFile: "k", vicSettledCount: 0, orders: [] } }, events: [] };
  const desk = new Desk(state, { supplierPayee: "S", metal, balanceOf: async () => 10_000, books, now: () => NOW, readPaymentIntent: async (id) => pis.get(id)! });
  return { desk, state, pis, pulls };
}

describe("the card authorisation is the guarantee", () => {
  it("authorise at order, credit before due, capture only the undisputed amount, then earn terms", async () => {
    const { desk, state, pis, pulls } = setup();
    expect((await desk.evaluate("globex")).terms).toBe("PREPAY");
    const r = await desk.placeAgentOrder("globex", { productId: "fx-backfill", units: 5, option: "card_net_7" });
    expect(r).toMatchObject({ ok: true, route: "CARD_AUTH", amount: 6_000 });
    const id = (r as { orderId: string }).orderId;

    pis.set("int_1", { status: "REQUIRES_CAPTURE", amount: 60, merchant_order_id: "STM-G1", metadata: { statement_hash: "0xh" } });
    expect(await desk.recordCardAuthorisation("globex", [id], { paymentIntentId: "int_1", airiMandateId: "mdt", statementId: "STM-G1", statementHash: "0xh" })).toBe(true);
    // The card-secured order never goes on the Metal tab.
    await desk.evaluate("globex");
    expect(pulls).toEqual([]);

    desk.applyCredit("globex", id, 1_200, "delivery QA: 1 batch stale");
    pis.set("int_1", { ...pis.get("int_1")!, status: "SUCCEEDED", captured_amount: 48 });
    expect(await desk.verifyCardCapture("globex", "int_1")).toBe(true);
    const o = state.buyers.globex!.orders[0]!;
    expect(o.collectedBy).toBe("card:int_1");
    expect(o.card).toMatchObject({ authorised: 6_000, captured: 4_800 });
    expect((await desk.evaluate("globex")).terms).toBe("NET_30");
    expect(checkBooks(state).filter((c) => !c.ok)).toEqual([]);

    // Counted once: the same payment cannot earn terms twice.
    expect(await desk.verifyVicPayment("globex", { paymentIntentId: "int_1", airiMandateId: "mdt", statementId: "STM-G1", statementHash: "0xh" })).toBe(false);
    expect(state.buyers.globex!.vicSettledCount).toBe(1);
    // After capture, a further credit cannot quietly move onto the Metal tab.
    expect(() => desk.applyCredit("globex", id, 100, "late claim")).toThrow(/needs a person/);
  });

  it("refuses an authorisation for the wrong amount, and a capture above what is owed", async () => {
    const { desk, pis } = setup();
    const r = await desk.placeAgentOrder("globex", { productId: "fx-backfill", units: 5, option: "card_net_7" });
    const id = (r as { orderId: string }).orderId;
    pis.set("int_2", { status: "REQUIRES_CAPTURE", amount: 70, merchant_order_id: "STM-G2", metadata: { statement_hash: "0xh" } });
    expect(await desk.recordCardAuthorisation("globex", [id], { paymentIntentId: "int_2", airiMandateId: "m", statementId: "STM-G2", statementHash: "0xh" })).toBe(false);
    pis.set("int_2", { ...pis.get("int_2")!, amount: 60 });
    expect(await desk.recordCardAuthorisation("globex", [id], { paymentIntentId: "int_2", airiMandateId: "m", statementId: "STM-G2", statementHash: "0xh" })).toBe(true);
    desk.applyCredit("globex", id, 1_200, "stale");
    pis.set("int_2", { ...pis.get("int_2")!, status: "SUCCEEDED", captured_amount: 60 });
    expect(await desk.verifyCardCapture("globex", "int_2")).toBe(false);
  });

  it("live check: flags a desk-counted capture Airwallex does not show", async () => {
    const { desk, state, pis } = setup();
    const id = ((await desk.placeAgentOrder("globex", { productId: "fx-backfill", units: 5, option: "card_net_7" })) as { orderId: string }).orderId;
    pis.set("int_3", { status: "REQUIRES_CAPTURE", amount: 60, merchant_order_id: "S", metadata: { statement_hash: "h" } });
    await desk.recordCardAuthorisation("globex", [id], { paymentIntentId: "int_3", airiMandateId: "m", statementId: "S", statementHash: "h" });
    pis.set("int_3", { ...pis.get("int_3")!, status: "SUCCEEDED", captured_amount: 60 });
    await desk.verifyCardCapture("globex", "int_3");
    const ok = await checkLive(state, { receiptStatus: async () => "0x1", paymentIntent: async () => ({ status: "SUCCEEDED", captured_amount: 60 }) });
    expect(ok.find((c) => c.name === "card capture int_3")!.ok).toBe(true);
    const bad = await checkLive(state, { receiptStatus: async () => "0x1", paymentIntent: async () => ({ status: "SUCCEEDED", captured_amount: 55 }) });
    expect(bad.find((c) => c.name === "card capture int_3")!.ok).toBe(false);
  });
});
