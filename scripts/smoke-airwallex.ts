/**
 * Live sandbox smoke test for the US account. Prints ids and statuses, never credentials.
 *   npm run smoke:airwallex
 * Checks: login, balances, global accounts, indicative FX rate, and whether
 * Payment Acceptance is enabled (by creating one throwaway 1 USD payment intent).
 */
import { AirwallexClient, AirwallexError, newRequestId } from "../src/airwallex/client.js";
import { config } from "../src/config.js";

const cfg = config();
const awx = new AirwallexClient({ baseUrl: cfg.AWX_BASE_URL, clientId: cfg.AWX_CLIENT_ID, apiKey: cfg.AWX_API_KEY });

async function step(name: string, fn: () => Promise<string>) {
  try {
    console.log(`✔ ${name}: ${await fn()}`);
  } catch (e) {
    const msg = e instanceof AirwallexError ? `${e.status} ${e.code ?? ""} ${e.message}` : String(e);
    console.log(`✘ ${name}: ${msg}`);
  }
}

await step("balances", async () => {
  const rows = await awx.get<{ currency: string; available_amount: number }[]>("/balances/current");
  const nonZero = rows.filter((r) => r.available_amount > 0);
  return nonZero.length ? nonZero.map((r) => `${r.currency} ${r.available_amount}`).join(", ") : "all zero (fund via deposit simulation)";
});

await step("global accounts", async () => {
  const res = await awx.get<{ items: { id: string; currency?: string; country_code?: string; status?: string }[] }>("/global_accounts");
  return res.items.length ? res.items.map((g) => `${g.id} ${g.country_code ?? ""} ${g.status ?? ""}`).join("; ") : "none yet";
});

await step("FX rate USD→SGD (indicative)", async () => {
  const r = await awx.get<{ rate: number }>("/fx/rates/current", { query: { sell_currency: "USD", buy_currency: "SGD", sell_amount: 100 } });
  return `rate ${r.rate}`;
});

await step("Payment Acceptance enabled?", async () => {
  const pi = await awx.post<{ id: string; status: string }>("/pa/payment_intents/create", {
    request_id: newRequestId(),
    amount: 1,
    currency: "USD",
    merchant_order_id: `smoke-${Date.now()}`,
  });
  return `yes — created ${pi.id} (${pi.status})`;
});
