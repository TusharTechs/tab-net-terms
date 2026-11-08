import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIN = resolve("node_modules/.bin/airi-cli");

/** Runs airi-cli with JSON output and telemetry off. The model never sees card data: credentials go to a 0600 file. */
async function airi<T>(args: string[], timeoutMs = 60_000): Promise<T> {
  const { stdout } = await run(BIN, [...args, "-o", "json", "--no-telemetry"], {
    timeout: timeoutMs,
    env: { ...process.env, AIRI_TELEMETRY_DISABLED: "1" },
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

export interface MandateItem {
  name: string;
  unitPrice: string;
  quantity: number;
}

export interface CreateMandateInput {
  source: string;
  paymentMethodId: string;
  merchantName: string;
  merchantUrl: string;
  merchantCountry: string;
  totalAmount: string;
  currency: string;
  items: MandateItem[];
  description: string;
}

export async function createMandate(m: CreateMandateInput): Promise<Record<string, unknown>> {
  for (const i of m.items) if (/[,:]/.test(i.name)) throw new Error(`item name may not contain ',' or ':': ${i.name}`);
  const args = [
    "mandate", "create",
    "--source", m.source,
    "--payment-method-id", m.paymentMethodId,
    "--merchant-name", m.merchantName,
    "--merchant-url", m.merchantUrl,
    "--merchant-country", m.merchantCountry,
    "--total-amount", m.totalAmount,
    "--currency", m.currency,
    "--description", m.description,
    ...m.items.flatMap((i) => ["--item", `name:${i.name},unit_price:${i.unitPrice},quantity:${i.quantity}`]),
  ];
  return airi(args);
}

/** Waits for the passkey approval, then writes the single-use credential to `file` (mode 0600). Returns only the receipt. */
export async function getCredentialToFile(mandateId: string, file: string, timeoutSec = 600): Promise<Record<string, unknown>> {
  return airi(["mandate", "get-credential", "--mandate-id", mandateId, "--file", file, "--force", "--timeout", String(timeoutSec)], (timeoutSec + 30) * 1000);
}

export async function reportResult(mandateId: string, result: "SUCCEEDED" | "CANCELLED" | "DECLINED", reason?: string) {
  return airi(["mandate", "result", "--mandate-id", mandateId, "--result", result, ...(reason ? ["--reason", reason] : [])]);
}

export async function listMandates(size = 10) {
  return airi<Record<string, unknown>>(["mandate", "list", "--size", String(size)]);
}
