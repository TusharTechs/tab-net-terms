import { describe, expect, it } from "vitest";
import { parsePull, parseStatus, usdzBalance } from "../src/metal/agent.js";

// Outputs copied from real metal-agent 0.3.3 runs on testnet (2026-11-08).
const STATUS_V2 = `mandate 0xceae4912e3b05d620681f02be8d7bc698cb599e5e66edc1aecf5368499f01164
description TAB debit mandate v2
principal 0x4d0a5161AbA00FB71397675a1919163d6e7cEd33
mandate-key 0x01571a7a (P-256)
token 0x000000000000000000000000000000000000B5d5
per-payment-cap 5 *USDZ
budget 2.5 *USDZ until expiry
starts 1794096000 (2026-11-08T00:00:00.000Z)
expiry 1796748467 (2026-12-08T16:47:47.000Z)
payee 0x6C7578104c945e6A0b21eD9f022abE197a40B6B4 Northwind Data https://northwind.example
account-type MetalAccount
bound yes
revoked no
spent 1.8 *USDZ of 2.5 *USDZ
payments 1`;

const PAID = `transaction 0x7beba4d475cbb256ea533d5b585845671c3999527d51d7d67200e2b80a1bbaff
outcome paid
spent 1.8 *USDZ of 9 *USDZ
payer 0x4d0a5161AbA00FB71397675a1919163d6e7cEd33
payee 0x6C7578104c945e6A0b21eD9f022abE197a40B6B4
amount 1.8 *USDZ`;

const REPEAT = `already paid, nothing sent\n${PAID}`;

const REFUSED = `outcome refused, not sent
reason mandate_budget_spent (the amount would take the mandate past its budget)
recorded no`;

describe("metal-agent output parsing", () => {
  it("parses mandate status into the credit engine's view", () => {
    const s = parseStatus(STATUS_V2);
    expect(s).toMatchObject({ bound: true, revoked: false, spent: 180, budget: 250, payments: 1, capPerPayment: 500 });
    expect(s.payees).toEqual(["0x6C7578104c945e6A0b21eD9f022abE197a40B6B4"]);
    expect(s.expiresAt?.toISOString()).toBe("2026-12-08T16:47:47.000Z");
    expect(s.mandateId).toMatch(/^0xceae4912/);
  });

  it("parses a paid pull and recognises an idempotent repeat", () => {
    expect(parsePull(PAID)).toMatchObject({ outcome: "paid", alreadyPaid: false, tx: expect.stringMatching(/^0x7beba4d4/) });
    expect(parsePull(REPEAT)).toMatchObject({ outcome: "paid", alreadyPaid: true });
  });

  it("parses a refusal with its reason code", () => {
    expect(parsePull(REFUSED)).toEqual({ outcome: "refused", reason: "mandate_budget_spent", detail: "the amount would take the mandate past its budget" });
  });

  it("reads a USDZ balance (18 decimals) as whole cents", async () => {
    const fake = (async () => new Response(JSON.stringify({ result: "0x0000000000000000000000000000000000000000000000054915956c40960000" }))) as unknown as typeof fetch;
    expect(await usdzBalance("https://rpc", "0x4d0a5161AbA00FB71397675a1919163d6e7cEd33", fake)).toBe(9_750);
  });
});

describe("recorded refusals", () => {
  it("keeps the transaction hash when a refusal is recorded on chain", () => {
    const out = `transaction 0x03a1dbc118105dbd8878728eb6d00325e04f969b18cd5bc9926adeddf789192a
outcome refused
reason mandate_outside_recurrence (the mandate has not started yet, or its dates have ended)
payer 0x4d0a
payee 0x6C75
amount 1.2 *USDZ`;
    expect(parsePull(out)).toEqual({ outcome: "refused", reason: "mandate_outside_recurrence", detail: "the mandate has not started yet, or its dates have ended", recordedTx: "0x03a1dbc118105dbd8878728eb6d00325e04f969b18cd5bc9926adeddf789192a" });
  });
});
