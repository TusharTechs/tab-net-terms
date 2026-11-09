/**
 * A tab statement (≤ $200) paid with a passkey-approved Visa Intelligent Commerce credential from Airi.
 *   npx tsx scripts/vic-statement.ts create          → statement + Airwallex payment intent + Airi mandate (prints approval link)
 *   npx tsx scripts/vic-statement.ts pay <stmtId>     → waits for approval, checks the mandate against the statement,
 *                                                       pays the intent, reports the result to Airi
 * Card data never reaches stdout or the model: Airi writes it to a 0600 file that is read once and deleted.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { AirwallexClient, newRequestId } from "../src/airwallex/client.js";
import { createMandate, getCredentialToFile, reportResult } from "../src/airi/cli.js";
import { config } from "../src/config.js";
import { fromMajor, toMajor } from "../src/domain/money.js";
import { VIC_MAX_PER_TXN } from "../src/domain/credit.js";

const PAYMENT_METHOD_ID = "6a54bf19-f0f0-49ae-b2ef-c593de41577a"; // Airi test card (Visa …1111)
const DIR = "data/vic";

const cfg = config();
const awx = new AirwallexClient({ baseUrl: cfg.AWX_BASE_URL, clientId: cfg.AWX_CLIENT_ID, apiKey: cfg.AWX_API_KEY });

interface Line { name: string; unitPrice: string; quantity: number }
interface StatementState {
  statementId: string;
  lines: Line[];
  total: string;
  hash: string;
  paymentIntentId: string;
  mandateId: string;
  mandateCreate: Record<string, unknown>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const statePath = (id: string) => `${DIR}/${id}.json`;

async function create() {
  mkdirSync(DIR, { recursive: true });
  const statementId = `STM-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const lines: Line[] = [
    { name: "Market data queries Nov 1 to 7", unitPrice: "0.04", quantity: 2400 },
    { name: "Historical backfill pack", unitPrice: "60.00", quantity: 1 },
    { name: "Priority SLA week", unitPrice: "30.00", quantity: 1 },
  ];
  const totalCents = lines.reduce((s, l) => s + fromMajor(l.unitPrice) * l.quantity, 0);
  if (totalCents > VIC_MAX_PER_TXN) throw new Error("statement over $200 must go to invoice, never split");
  const total = toMajor(totalCents);
  const hash = sha256(JSON.stringify({ statementId, lines, total, currency: "USD" }));

  const pi = await awx.post<{ id: string; amount: number; currency: string; status: string }>("/pa/payment_intents/create", {
    request_id: newRequestId(),
    amount: Number(total),
    currency: "USD",
    merchant_order_id: statementId,
    metadata: { statement_hash: hash, rail: "VIC via Airi" },
  });
  const readBack = await awx.get<{ amount: number; status: string }>(`/pa/payment_intents/${pi.id}`);
  console.log(JSON.stringify({ statementId, total, hash: hash.slice(0, 16), paymentIntent: pi.id, piAmountReadBack: readBack.amount, piStatus: readBack.status }));

  const mandateCreate = await createMandate({
    source: "Acme procurement agent",
    paymentMethodId: PAYMENT_METHOD_ID,
    merchantName: "Northwind Data",
    merchantUrl: "https://northwind.example",
    merchantCountry: "US",
    totalAmount: total,
    currency: "USD",
    items: lines,
    description: `Statement ${statementId} sha256 ${hash.slice(0, 16)}`,
  });
  const mandateId = String(mandateCreate.mandate_id ?? mandateCreate.mandateId ?? mandateCreate.id);
  const state: StatementState = { statementId, lines, total, hash, paymentIntentId: pi.id, mandateId, mandateCreate };
  writeFileSync(statePath(statementId), JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ mandateId, mandateCreate }, null, 2));
}

async function pay(statementId: string) {
  const s = JSON.parse(readFileSync(statePath(statementId), "utf8")) as StatementState;
  const credFile = `${DIR}/${statementId}.cred.json`;

  // Supplier-side checks before any card data is used: the statement is unchanged and under the VIC cap.
  const hash = sha256(JSON.stringify({ statementId: s.statementId, lines: s.lines, total: s.total, currency: "USD" }));
  if (hash !== s.hash) throw new Error("statement changed since the mandate was created; void instead of paying");
  if (fromMajor(s.total) > VIC_MAX_PER_TXN) throw new Error("over the VIC cap");

  const receipt = await getCredentialToFile(s.mandateId, credFile);
  console.log(JSON.stringify({ step: "credential", receipt }));
  const mode = statSync(credFile).mode & 0o777;
  if (mode !== 0o600) throw new Error(`credential file mode ${mode.toString(8)}, expected 600`);

  let result: "SUCCEEDED" | "DECLINED" = "DECLINED";
  let reason = "";
  try {
    const cred = JSON.parse(readFileSync(credFile, "utf8")) as Record<string, any>;
    console.log(JSON.stringify({ step: "credential-shape", keys: Object.keys(cred), nested: Object.fromEntries(Object.entries(cred).filter(([, v]) => v && typeof v === "object").map(([k, v]) => [k, Object.keys(v)])) }));
    const c = cred.credential ?? cred.card ?? cred;
    const number = c.number ?? c.pan ?? c.tokenNumber ?? c.token;
    const expiryMonth = String(c.expiryMonth ?? c.expiry_month ?? c.expMonth ?? "").padStart(2, "0");
    let expiryYear = String(c.expiryYear ?? c.expiry_year ?? c.expYear ?? "");
    if (expiryYear.length === 2) expiryYear = `20${expiryYear}`;
    const cvc = c.cvv ?? c.cvc ?? c.securityCode;
    if (!number || !expiryMonth || !expiryYear || !cvc) throw new Error("credential file is missing a field; see credential-shape above");

    // Authorise only. Nothing is captured until the authorised amount matches the statement.
    type PI = { id: string; status: string; amount: number; captured_amount?: number; latest_payment_attempt?: { status?: string; authorization_code?: string } };
    const authorised = await awx.post<PI>(`/pa/payment_intents/${s.paymentIntentId}/confirm`, {
      request_id: newRequestId(),
      payment_method: { type: "card", card: { number: String(number), expiry_month: expiryMonth, expiry_year: expiryYear, cvc: String(cvc), name: "Acme Procurement" } },
      payment_method_options: { card: { auto_capture: false, authorization_type: "pre_auth" } },
    });
    console.log(JSON.stringify({ step: "authorise", paymentIntent: authorised.id, status: authorised.status, amount: authorised.amount, attempt: authorised.latest_payment_attempt?.status }));

    if (authorised.status !== "REQUIRES_CAPTURE") {
      reason = `payment intent ${authorised.status}`;
    } else if (fromMajor(String(authorised.amount)) !== fromMajor(s.total)) {
      const voided = await awx.post<PI>(`/pa/payment_intents/${s.paymentIntentId}/cancel`, { request_id: newRequestId(), cancellation_reason: "amount does not match statement" });
      reason = `authorised ${authorised.amount} ≠ statement ${s.total}; voided (${voided.status})`;
    } else {
      const captured = await awx.post<PI>(`/pa/payment_intents/${s.paymentIntentId}/capture`, { request_id: newRequestId(), amount: Number(s.total) });
      console.log(JSON.stringify({ step: "capture", paymentIntent: captured.id, status: captured.status, captured: captured.captured_amount ?? captured.amount }));
      if (captured.status === "SUCCEEDED") result = "SUCCEEDED";
      else reason = `capture left intent ${captured.status}`;
    }
  } catch (e) {
    reason = e instanceof Error ? e.message.slice(0, 180) : String(e);
    console.log(JSON.stringify({ step: "confirm-error", reason }));
  } finally {
    unlinkSync(credFile);
  }

  const reported = await reportResult(s.mandateId, result, result === "DECLINED" ? reason : undefined);
  console.log(JSON.stringify({ step: "airi-result", result, reported }));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "create") await create();
else if (cmd === "pay" && arg) await pay(arg);
else throw new Error("usage: vic-statement.ts create | pay <statementId>");
