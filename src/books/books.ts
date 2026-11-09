import { readFileSync } from "node:fs";
import type { InvoiceRecord } from "../domain/credit.js";

/**
 * Where the supplier's receivables history comes from. The credit engine only sees
 * InvoiceRecord[]; which system produced them is reported as `source` so the demo
 * never presents stand-in data as T:0 data.
 */
export interface Books {
  readonly source: "t0" | "standin";
  invoicesFor(customerId: string): Promise<InvoiceRecord[]>;
}

interface StandinInvoice {
  id: string;
  customerId: string;
  amountCents: number;
  dueDate: string;
  paidAt?: string;
}

/** Local, clearly labelled stand-in used while the T:0 key is unavailable. */
export class StandinBooks implements Books {
  readonly source = "standin" as const;
  private readonly rows: StandinInvoice[];
  constructor(path: string) {
    this.rows = JSON.parse(readFileSync(path, "utf8")) as StandinInvoice[];
  }
  async invoicesFor(customerId: string): Promise<InvoiceRecord[]> {
    return this.rows
      .filter((r) => r.customerId === customerId)
      .map((r) => ({ id: r.id, amount: r.amountCents, dueDate: new Date(r.dueDate), ...(r.paidAt ? { paidAt: new Date(r.paidAt) } : {}) }));
  }
  /** Demo control: mark an invoice paid (stand-in only; T:0 writes go through its own API). */
  markPaid(invoiceId: string, at: Date) {
    const r = this.rows.find((x) => x.id === invoiceId);
    if (r) r.paidAt = at.toISOString();
  }
}

/**
 * Minimal client for T:0's MCP server (streamable HTTP, JSON-RPC, bearer auth).
 * Verified on 2026-11-08: initialize and tools/list work; tool calls reach T:0's API
 * but the issued key returns 401 CAPI15. Invoice field mapping is written once real
 * records can be read; until then T0Books is not used by the desk.
 */
export class T0Mcp {
  constructor(
    private readonly apiKey: string,
    private readonly url = "",
  ) {}

  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: args } }),
    });
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    const msg = JSON.parse(data ? data.slice(6) : text) as { result?: { content?: { text: string }[]; isError?: boolean }; error?: { message: string } };
    if (msg.error) throw new Error(`T:0 ${tool}: ${msg.error.message}`);
    const body = msg.result?.content?.[0]?.text ?? "";
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.status === "number" && parsed.status >= 400) {
      throw new Error(`T:0 ${tool}: ${parsed.status} ${parsed.body?.error_code ?? ""} ${parsed.body?.detail ?? ""}`.trim());
    }
    return parsed as T;
  }
}
