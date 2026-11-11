import { T0Mcp } from "./books.js";

/**
 * Writing records into T:0 (as opposed to journal entries). Needs a key issued with a
 * Custom API connection (T0_IMPORT_API_KEY); the read/JE key is refused with CAPI72.
 *
 * T:0's rules, from its API docs: a batch is all-or-nothing; resubmitting a record with the
 * same id replaces it (an identical one counts as a duplicate), so every id here is fixed and
 * a re-run is safe. Accepted records show in the T:0 app at once, but the API reads them back
 * only after T:0's next nightly run, under a T:0 id; our own id becomes the record's
 * `platform_object_id`. A Customer is readable only once a transaction links to it.
 */
export interface T0Ref {
  dataType: string;
  externalId: string;
}
export interface T0Record {
  id: T0Ref;
  data: Record<string, unknown>;
  links?: T0Ref[];
}

const day = (d: Date | string) => (typeof d === "string" ? d : d.toISOString().slice(0, 10));
const usd = (cents: number) => Math.round(cents) / 100;

export function customerRecord(id: string, name: string, email: string, date: string): T0Record {
  return { id: { dataType: "Customer", externalId: id }, data: { date, name, email, customFields: { source: "TAB demo buyer" } } };
}

/** An invoice and, when it was paid, the payment that settled it (T:0 refuses externalTotal ≠ total). */
export function invoiceRecords(p: { id: string; customerId: string; amountCents: number; issued: string; due: string; paidAt?: string; memo: string }): T0Record[] {
  const amount = usd(p.amountCents);
  const inv: T0Record = {
    id: { dataType: "Invoice", externalId: p.id },
    data: { date: p.issued, issuedDate: p.issued, dueDate: p.due, currencyCode: "USD", subtotal: amount, externalSubtotal: amount, tax: 0, total: amount, externalTotal: amount, status: p.paidAt ? "paid" : "open", paidDate: p.paidAt ?? null, customFields: { memo: p.memo } },
    links: [{ dataType: "Customer", externalId: p.customerId }],
  };
  if (!p.paidAt) return [inv];
  return [
    inv,
    {
      id: { dataType: "Payment", externalId: `${p.id}-payment` },
      data: { date: p.paidAt, succeededDate: p.paidAt, amount, currencyCode: "USD", status: "succeeded", description: `Payment for ${p.id}` },
      links: [
        { dataType: "Customer", externalId: p.customerId },
        { dataType: "Invoice", externalId: p.id },
      ],
    },
  ];
}

/** The bill payment for a vendor bill TAB paid by Airwallex transfer. */
export function billPaymentRecord(p: { billExternalId: string; vendorExternalId: string; amountCents: number; date: Date | string; transferId: string; shortRef: string }): T0Record {
  return {
    id: { dataType: "BillPayment", externalId: `tab-billpay-${p.billExternalId}` },
    data: { date: day(p.date), amount: usd(p.amountCents), currencyCode: "USD", type: "bill", customFields: { airwallex_transfer_id: p.transferId, airwallex_short_reference: p.shortRef } },
    links: [
      { dataType: "VendorBill", externalId: p.billExternalId },
      { dataType: "Vendor", externalId: p.vendorExternalId },
    ],
  };
}

export async function submitRecords(t0: T0Mcp, records: T0Record[]): Promise<unknown> {
  return t0.call("create_records", { body: records });
}
