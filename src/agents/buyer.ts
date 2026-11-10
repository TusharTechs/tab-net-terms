import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import type { ClaudeTarget } from "../claude/client.js";
import type { Desk } from "../desk/desk.js";
import type { Cents } from "../domain/money.js";
import { type BuyerPolicy, CATALOG, checkBuyerPolicy, type Offer } from "../terms/offers.js";

/**
 * A buyer's procurement agent, run by Claude with typed tools bound to ONE buyer identity.
 * It decides what to buy and how to pay. Prices, terms and limits come only from the desk's
 * code; its human's rules are enforced in code before an order is sent. Its explanation is
 * recorded for the screen and never used to decide anything.
 */

export interface BuyerPersona {
  buyerId: string;
  company: string;
  agentName: string;
  /** What the agent is trying to get done, in its human's words. */
  goal: string;
  policy: BuyerPolicy;
  /** Context about the buyer's own cash (informational for the agent). */
  cashNote: string;
}

const dollars = (c: Cents) => `$${(c / 100).toFixed(2)}`;

function offerForModel(o: Offer) {
  return {
    product_id: o.productId,
    units: o.units,
    list_price: dollars(o.listAmount),
    options: o.options.map((x) => ({
      option: x.option,
      you_pay: dollars(x.amount),
      due_in_days: x.dueInDays,
      discount: `${(x.discount * 100).toFixed(0)}%`,
      ...(x.annualisedReturn !== undefined ? { annualised_return_of_discount: `${(x.annualisedReturn * 100).toFixed(1)}%` } : {}),
      description: x.description,
    })),
    notes: o.notes,
  };
}

export interface BuyerRunResult {
  finalText: string;
  orders: string[];
  refusals: string[];
  toolCalls: number;
  stopReason: string | null;
  usage: { input: number; output: number };
}

export async function runBuyerAgent(target: ClaudeTarget, desk: Desk, persona: BuyerPersona, opts: { maxIterations?: number } = {}): Promise<BuyerRunResult> {
  let spent: Cents = 0;
  let toolCalls = 0;
  const orders: string[] = [];
  const refusals: string[] = [];
  const id = persona.buyerId;

  const tools = [
    betaZodTool({
      name: "get_catalog",
      description: "List Northwind Data's products with unit prices.",
      inputSchema: z.object({}),
      run: async () => {
        toolCalls++;
        return JSON.stringify(CATALOG.map((p) => ({ product_id: p.id, name: p.name, unit_price: `${p.unitPrice}¢ per ${p.unit}`, max_units: p.maxUnits })));
      },
    }),
    betaZodTool({
      name: "get_account",
      description: "Your current standing with Northwind: payment terms, credit limit, available credit, what you owe, and your spend this month.",
      inputSchema: z.object({}),
      run: async () => {
        toolCalls++;
        const d = await desk.evaluate(id);
        return JSON.stringify({ terms: d.terms, credit_limit: dollars(d.limit), available_credit: dollars(d.available), why: d.reasons.map((r) => r.detail), spent_this_month: dollars(spent), your_monthly_budget: dollars(persona.policy.monthlyBudget), your_max_order: dollars(persona.policy.maxOrder) });
      },
    }),
    betaZodTool({
      name: "get_offer",
      description: "Get Northwind's priced offer for a product and quantity, with every payment option you currently qualify for (pay now by card; a short tab secured by a card authorisation; or on your tab: net-7, net-30, or a discount for paying within 10 days).",
      inputSchema: z.object({ product_id: z.string(), units: z.number().int().min(1) }),
      run: async ({ product_id, units }) => {
        toolCalls++;
        try {
          return JSON.stringify(offerForModel(await desk.offerFor(id, product_id, units)));
        } catch (e) {
          return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    }),
    betaZodTool({
      name: "place_order",
      description: "Place an order using one of the payment options returned by get_offer. Northwind re-checks everything; anything not on offer is refused.",
      inputSchema: z.object({
        product_id: z.string(),
        units: z.number().int().min(1),
        option: z.enum(["prepay_card", "card_net_7", "net_7", "net_30", "pay_in_10_discount"]),
        note: z.string().max(500).optional().describe("Optional note to Northwind (for humans; never changes terms)."),
      }),
      run: async ({ product_id, units, option, note }) => {
        toolCalls++;
        // The buyer's own human-set rules, enforced in code before anything is sent.
        let amount: Cents;
        try {
          const offer = await desk.offerFor(id, product_id, units);
          amount = offer.options.find((o) => o.option === option)?.amount ?? offer.listAmount;
        } catch (e) {
          return JSON.stringify({ ok: false, reason: e instanceof Error ? e.message : String(e) });
        }
        const blocked = checkBuyerPolicy(persona.policy, spent, amount);
        if (blocked) {
          refusals.push(`buyer policy: ${blocked}`);
          return JSON.stringify({ ok: false, reason: `blocked by your own company's policy: ${blocked}` });
        }
        const r = await desk.placeAgentOrder(id, { productId: product_id, units, option, ...(note ? { note } : {}) });
        if (r.ok) {
          spent += r.amount;
          orders.push(r.orderId);
          return JSON.stringify({ ok: true, order_id: r.orderId, you_pay: dollars(r.amount), due: r.dueAt ?? "paid by card now" });
        }
        refusals.push(`desk: ${r.reason}`);
        return JSON.stringify({ ok: false, reason: r.reason });
      },
    }),
  ];

  const system = `You are ${persona.agentName}, the procurement agent for ${persona.company}. You buy data from Northwind Data using the tools provided.

Your human's goal: ${persona.goal}
Your company's rules (enforced in code; orders that break them are blocked): max ${dollars(persona.policy.maxOrder)} per order, ${dollars(persona.policy.monthlyBudget)} monthly budget. Your company's cost of capital is ${(persona.policy.costOfCapital * 100).toFixed(0)}% a year.
${persona.cashNote}

Work only from what the tools return: never assume a price, a credit limit or a payment option. Choose the payment option that is best for your company and say why. When you are done, reply with two or three plain sentences for your CFO (no tables, lists or markdown): what you bought, how you are paying, and why.`;

  const runner = (target.client as any).beta.messages.toolRunner({
    ...target.requestExtras,
    model: target.model,
    max_tokens: 16000,
    max_iterations: opts.maxIterations ?? 12,
    output_config: { effort: "medium" },
    system,
    tools,
    messages: [{ role: "user", content: "Go ahead: work out what to buy this month and place the orders." }],
  });
  const final = await runner;
  const finalText = (final.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  if (finalText) desk.recordAgentNote(id, `${persona.agentName}: ${finalText}`, { model: final.model, orders, refusals, toolCalls });
  return { finalText, orders, refusals, toolCalls, stopReason: final.stop_reason ?? null, usage: { input: final.usage?.input_tokens ?? 0, output: final.usage?.output_tokens ?? 0 } };
}
