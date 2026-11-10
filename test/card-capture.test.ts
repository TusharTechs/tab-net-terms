import { describe, expect, it } from "vitest";
import { type AirwallexClient, AirwallexError } from "../src/airwallex/client.js";
import type { CreditDecision } from "../src/domain/credit.js";
import { quote } from "../src/terms/offers.js";
import { type CardStatement, captureCard } from "../src/visa/card-statement.js";

const st: CardStatement = { statementId: "S1", hash: "h", total: 6_000, lines: [], paymentIntentId: "int_1", airiMandateId: "m", passkeyUrl: "" };

function fakeAwx(pi: { status: string; captured_amount?: number }, opts: { duplicateOnCapture?: boolean } = {}) {
  const posts: { path: string; body: any }[] = [];
  const awx = {
    get: async () => ({ ...pi }),
    post: async (path: string, body: any) => {
      posts.push({ path, body });
      if (opts.duplicateOnCapture) {
        pi.status = "SUCCEEDED";
        pi.captured_amount = body.amount;
        throw new AirwallexError(400, "duplicate_request_id", "dup", undefined, path);
      }
      if (path.endsWith("/capture")) { pi.status = "SUCCEEDED"; pi.captured_amount = body.amount; }
      if (path.endsWith("/cancel")) pi.status = "CANCELLED";
      return { ...pi };
    },
  } as unknown as AirwallexClient;
  return { awx, posts, pi };
}

describe("card capture", () => {
  it("captures exactly the amount given, with a request id derived from the payment", async () => {
    const { awx, posts } = fakeAwx({ status: "REQUIRES_CAPTURE" });
    expect(await captureCard(awx, st, 4_800)).toMatchObject({ captured: 4_800, alreadyDone: false });
    expect(posts).toEqual([{ path: "/pa/payment_intents/int_1/capture", body: { request_id: "capture-int_1", amount: 48 } }]);
  });

  it("a retry after success sends nothing", async () => {
    const { awx, posts } = fakeAwx({ status: "SUCCEEDED", captured_amount: 48 });
    expect(await captureCard(awx, st, 4_800)).toMatchObject({ captured: 4_800, alreadyDone: true });
    expect(posts).toEqual([]);
  });

  it("a retry whose first response was lost reads back what Airwallex holds", async () => {
    const { awx } = fakeAwx({ status: "REQUIRES_CAPTURE" }, { duplicateOnCapture: true });
    expect(await captureCard(awx, st, 4_800)).toMatchObject({ captured: 4_800, status: "SUCCEEDED", alreadyDone: true });
  });

  it("never captures more than the authorisation; 0 voids it", async () => {
    await expect(captureCard(fakeAwx({ status: "REQUIRES_CAPTURE" }).awx, st, 6_001)).rejects.toThrow(/outside/);
    const { awx, posts } = fakeAwx({ status: "REQUIRES_CAPTURE" });
    expect(await captureCard(awx, st, 0)).toMatchObject({ captured: 0, status: "CANCELLED" });
    expect(posts[0]!.body.request_id).toBe("cancel-int_1");
  });
});

describe("card-secured tab exposure", () => {
  const prepay: CreditDecision = { buyerId: "g", terms: "PREPAY", limit: 0, available: 0, collectNow: 0, escalate: 0, reasons: [{ code: "NO_VIC_HISTORY", detail: "" }] };
  it("all open card-secured tabs together must fit one $200 authorisation", () => {
    expect(quote("fx-backfill", 5, prepay, undefined, { cardOpen: 15_000 }).options.map((o) => o.option)).toEqual(["prepay_card"]);
    expect(quote("fx-backfill", 4, prepay, undefined, { cardOpen: 15_000 }).options.map((o) => o.option)).toEqual(["prepay_card", "card_net_7"]);
  });
});
