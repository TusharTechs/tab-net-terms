import { config } from "../config.js";
import { readFileSync } from "node:fs";
import type { InvoiceRecord } from "../domain/credit.js";

/**
 * Where the supplier's receivables history comes from. The credit engine only sees
 * InvoiceRecord[]; which system produced them is reported as `source` so the demo
 * never presents stand-in data as T:0 data.
 */
export type BooksSource = "t0" | "standin";

export interface Books {
  readonly source: BooksSource;
  invoicesFor(customerId: string): Promise<InvoiceRecord[]>;
  /** Which system answers for this buyer (defaults to `source`). */
  sourceFor?(buyerId: string): BooksSource;
}

/** Routes each buyer to the books that hold its history (T:0 for some, stand-in for others). */
export class RoutedBooks implements Books {
  readonly source: BooksSource = "t0";
  constructor(
    private readonly routes: Record<string, Books>,
    private readonly fallback: Books,
  ) {}
  private pick(buyerId: string) {
    return this.routes[buyerId] ?? this.fallback;
  }
  invoicesFor(buyerId: string) {
    return this.pick(buyerId).invoicesFor(buyerId);
  }
  sourceFor(buyerId: string) {
    return this.pick(buyerId).source;
  }
}

/**
 * Reads a buyer's real invoice history from T:0. Acme is mapped to an existing T:0 customer;
 * Initech and Globex are customers we submitted to the T:0 sandbox (scripts/t0-seed-buyers.ts).
 * A buyer with no T:0 customer id reads as no invoices. Loaded once and cached; refresh() re-reads.
 */
export class T0Books implements Books {
  readonly source = "t0" as const;
  private cache = new Map<string, InvoiceRecord[]>();
  asOf = "";
  constructor(
    private readonly t0: T0Mcp,
    /** desk buyer id → T:0 customer external id */
    readonly customerFor: Record<string, string>,
  ) {}

  async refresh(maxPages = 30) {
    const wanted = new Set(Object.values(this.customerFor));
    const byCustomer = new Map<string, InvoiceRecord[]>();
    for (const status of ["open", "paid", "uncollectible"]) {
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const r = await this.t0.call<{ data: T0Invoice[]; next_cursor?: string; as_of?: string }>("list_invoices", { status: [status], limit: 50, ...(cursor ? { cursor } : {}) });
        this.asOf = r.as_of ?? this.asOf;
        for (const inv of r.data ?? []) {
          const c = inv.links?.find((l) => l.dataType === "Customer")?.externalId;
          if (!c || !wanted.has(c) || !inv.data.dueDate) continue;
          const rec = toInvoiceRecord(inv);
          (byCustomer.get(c) ?? byCustomer.set(c, []).get(c)!).push(rec);
        }
        cursor = r.next_cursor ?? undefined;
        if (!cursor) break;
      }
    }
    this.cache = byCustomer;
  }

  async invoicesFor(buyerId: string): Promise<InvoiceRecord[]> {
    const c = this.customerFor[buyerId];
    return c ? (this.cache.get(c) ?? []) : [];
  }
}

/**
 * Finds the T:0 ids of customers we submitted ourselves (scripts/t0-seed-buyers.ts): T:0 gives each
 * record its own id and keeps ours as `platform_object_id`. Customers T:0 does not return yet are left out.
 */
export async function resolveT0Customers(t0: T0Mcp, ours: Record<string, string>): Promise<Record<string, string>> {
  const ids = Object.values(ours);
  if (!ids.length) return {};
  const r = await t0.call<{ data?: { id: { externalId: string }; data: { customFields?: { t0_platform_object_id?: string } } }[] }>("list_customers", { platform_object_ids: ids });
  const byOurs = new Map((r.data ?? []).map((c) => [c.data.customFields?.t0_platform_object_id, c.id.externalId]));
  const out: Record<string, string> = {};
  for (const [buyer, id] of Object.entries(ours)) {
    const found = byOurs.get(id);
    if (found) out[buyer] = found;
  }
  return out;
}

interface T0Invoice {
  id: { externalId: string };
  data: { dueDate: string | null; paidDate: string | null; status: string; total: number };
  links?: { dataType: string; externalId: string }[];
}

export function toInvoiceRecord(inv: T0Invoice): InvoiceRecord {
  return {
    id: inv.id.externalId,
    amount: Math.round(inv.data.total * 100),
    dueDate: new Date(inv.data.dueDate!),
    ...(inv.data.status === "paid" && inv.data.paidDate ? { paidAt: new Date(inv.data.paidDate) } : {}),
  };
}

/** GL accounts used to book a settled collection (T:0 sandbox chart). */
export const T0_GL = {
  /** 11410 "Payment Processor #1": stands for the Airwallex wallet the collection settled into. */
  cash: "glacct_prod_rhvrdWJ9CvupsH9V",
  /** 12100 "A/R - Customers" */
  receivable: "glacct_prod_OyqxStjVO6dHgLrK",
  /** 21110 "A/P - Vendors" */
  payable: "glacct_prod_4rlsPQbo9OX2y39J",
};

/**
 * Books a settled collection in T:0: debit cash (Airwallex), credit A/R for the customer.
 * Idempotent on the Metal tx hash: T:0 refuses a repeated key (409) and names the entry it made.
 */
export async function bookCollection(
  t0: T0Mcp,
  p: { customerExternalId: string; amount: number; currency: string; metalTx: string; depositId: string; conversionId?: string; date: Date },
): Promise<{ journalEntryId: string; jeNumber?: string; alreadyBooked: boolean }> {
  const body = {
    entry_date: p.date.toISOString().slice(0, 10),
    currency: p.currency,
    memo: `TAB collection settled into Airwallex. Metal tx ${p.metalTx}; Airwallex deposit ${p.depositId}${p.conversionId ? `; conversion ${p.conversionId}` : ""}`,
    manual_entry_reason: "Agent tab collected via Metal debit mandate and settled into Airwallex",
    idempotency_key: `tab-collect-${p.metalTx}`.slice(0, 128),
    lines: [
      { gl_account_id: T0_GL.cash, line_type: "debit", amount_atoms: p.amount, memo: `Airwallex deposit ${p.depositId}` },
      { gl_account_id: T0_GL.receivable, line_type: "credit", amount_atoms: p.amount, memo: `Metal tx ${p.metalTx}`, counterparty_type: "customer", counterparty_external_id: p.customerExternalId },
    ],
  };
  try {
    const je = await t0.call<{ id: string; je_number?: string }>("post_a_manual_journal_entry", { body });
    return { journalEntryId: je.id, ...(je.je_number ? { jeNumber: je.je_number } : {}), alreadyBooked: false };
  } catch (e) {
    const m = /CAPI34.*created (je_[A-Za-z0-9_]+)/.exec(String(e));
    if (m) return { journalEntryId: m[1]!, alreadyBooked: true };
    throw e;
  }
}

interface StandinInvoice {
  id: string;
  customerId: string;
  amountCents: number;
  dueDate: string;
  paidAt?: string;
}

/** Local, clearly labelled stand-in, used only for a buyer T:0 does not return (or with no T:0 key). */
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
 * The key decides what a call may do: the account key reads records and posts journal
 * entries; a Custom API connection key also submits records (create_records).
 */
export class T0Mcp {
  constructor(
    private readonly apiKey: string,
    private readonly url: string = config().T0_MCP_URL ?? "",
  ) {}

  /** Retries only T:0's "another write is in progress" (409 CAPI02) and 429/5xx; every other error passes through. */
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}, attempts = 4): Promise<T> {
    if (!this.url) throw new Error("T0_MCP_URL missing: set it in .env to the T:0 MCP endpoint issued with your key");
    for (let i = 1; ; i++) {
      try {
        return await this.callOnce<T>(tool, args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (i >= attempts || !/: (409 CAPI02|429|5\d\d)\b/.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  }

  private async callOnce<T>(tool: string, args: Record<string, unknown>): Promise<T> {
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
    // T:0's MCP wraps every answer as { status, headers, body }.
    if (parsed && typeof parsed === "object" && typeof parsed.status === "number" && "body" in parsed) {
      if (parsed.status >= 400) throw new Error(`T:0 ${tool}: ${parsed.status} ${parsed.body?.error_code ?? ""} ${parsed.body?.detail ?? ""}`.trim());
      return parsed.body as T;
    }
    return parsed as T;
  }
}
