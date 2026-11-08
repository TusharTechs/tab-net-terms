import { describe, expect, it } from "vitest";
import { AirwallexClient, AirwallexError } from "../src/airwallex/client.js";

type Reply = { status: number; body: unknown };

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/authentication/login")) {
      return new Response(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }), { status: 201 });
    }
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "x-b3-traceid": "trace-1" } });
  }) as typeof fetch;
  return { impl, calls };
}

const make = (replies: Reply[]) => {
  const f = fakeFetch(replies);
  const client = new AirwallexClient({ baseUrl: "https://x", clientId: "c", apiKey: "k", fetch: f.impl, sleep: async () => {} });
  return { client, calls: f.calls };
};

describe("AirwallexClient", () => {
  it("logs in once and reuses the token", async () => {
    const { client, calls } = make([{ status: 200, body: { a: 1 } }, { status: 200, body: { a: 2 } }]);
    await client.get("/balances/current");
    await client.get("/balances/current");
    expect(calls.filter((c) => c.url.endsWith("/authentication/login"))).toHaveLength(1);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const { client } = make([{ status: 429, body: {} }, { status: 503, body: {} }, { status: 200, body: { ok: true } }]);
    await expect(client.get("/x")).resolves.toEqual({ ok: true });
  });

  it("never retries a business 4xx", async () => {
    const { client, calls } = make([{ status: 400, body: { code: "duplicate_request_id", message: "dup" } }]);
    const err = (await client.post("/transfers/create", { request_id: "r" }).catch((e: unknown) => e)) as AirwallexError;
    expect(err).toBeInstanceOf(AirwallexError);
    expect(err.code).toBe("duplicate_request_id");
    expect(err.traceId).toBe("trace-1");
    expect(calls.filter((c) => !c.url.endsWith("/authentication/login"))).toHaveLength(1);
  });

  it("refreshes the token once on 401", async () => {
    const { client, calls } = make([{ status: 401, body: {} }, { status: 200, body: { ok: 1 } }]);
    await expect(client.get("/x")).resolves.toEqual({ ok: 1 });
    expect(calls.filter((c) => c.url.endsWith("/authentication/login"))).toHaveLength(2);
  });

  it("sends x-on-behalf-of only when asked", async () => {
    const { client, calls } = make([{ status: 200, body: {} }]);
    await client.get("/balances/current", { onBehalfOf: "acct_123" });
    const headers = calls.at(-1)!.init!.headers as Record<string, string>;
    expect(headers["x-on-behalf-of"]).toBe("acct_123");
  });

  it("recognises every insufficient-funds code", () => {
    for (const code of ["balance_insufficient", "insufficient_fund", "insufficient_funds"]) {
      expect(new AirwallexError(400, code, "", undefined, "/p").isInsufficientFunds).toBe(true);
    }
  });
});
