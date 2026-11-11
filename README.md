<p align="center"><img src="public/favicon.svg" width="96" height="96" alt="TAB logo: a buyer's tab, paid later, landing as a check"></p>

# TAB — net terms for AI agents

**Every other agent-payments project teaches agents to hear "no". TAB says "yes, pay later" — and still gets paid.**

Airwallex Agentic Banking Hackathon entry (team: Four Eyes, One Human).

Businesses buy from each other on credit: net-30, 2% off for paying in 10 days. When the buyer is an AI agent, suppliers have no way to extend that credit safely, so agents are stuck paying upfront by card. TAB is the supplier's credit desk for agent buyers. **Northwind Data**, a B2B data supplier, sells to buyer agents on terms; every limit, price and collection is decided by code and enforced by the rails, and every dollar is proven at the end.

## How it works

| Rail | What TAB uses it for |
| --- | --- |
| **Claude** (`claude-opus-5-5`) | Three jobs, never deciding money: the **CFO policy compiler** (plain-English goals → typed policy changes), the **buyer agents** (Acme's and Globex's) that shop and choose how to pay through typed tools, and the **dispute reader** (email → claims). The model proposes; code decides. |
| **Metal** (testnet) | The buyer's human binds a **debit mandate** naming Northwind: that is the credit line, and the limit can never exceed it. Each **statement becomes its own mandate** (cap and budget = the statement total, one payment, a due window): the chain refuses early and repeated collections, and Northwind records each refusal on chain. |
| **Visa Intelligent Commerce** (via Airi) | A buyer with no history gets a short **tab secured by a passkey-approved card authorisation**; at the due date only the **undisputed amount is captured**. That verified payment is what earns Metal terms. |
| **Airwallex** (sandbox) | Reads back every card payment before it counts; settles each collection (deposit → refund reserve → FX quote → conversion to SGD); pays Northwind's own vendor bills by **transfer**, funded only from that proven SGD. |
| **T:0** (sandbox) | Every buyer's payment history is read from T:0 and decides net-30 vs net-7 vs prepay; every settled collection is posted as a balanced journal entry tied to its Metal tx; the demo's Initech and Globex books and Slack bills are records written into the sandbox through a custom API connection. |

The rules that never move: no credit before a Visa-verified payment, and each payment counts once, for one buyer; when the buyer's human lowers their mandate (or the buyer is demoted to prepay) the desk collects the whole tab at once, while any other drop in the limit collects only the excess; orders are never split to dodge the $200 card cap; credits are priced at what the buyer actually paid.

## The demo (one live run, every id real)

`LIVE_VIC=1 npx tsx scripts/demo-run.ts` plays the story against the live rails; `npm run screen` shows it as it happens. **No keys needed to look:** [`docs/index.html`](docs/index.html) is the same screen with run `rmwavgb3a` inlined: an overview, the live desk (play, step or jump to a scene, with every event moving across a map of the rails), the guarantees, the proof with every id, what each rail does, and a 90-second guided tour. Full ids and the after-run re-checks: [`proofs/demo-run.md`](proofs/demo-run.md) (21/21 checks).

**Live, not a mock.** The replay page and the video are recordings of one live run, `rmwavgb3a`; nothing in them is staged data. The screen streams the desk's real event log. What is simulated is listed under "What is simulated or labelled" below.

### Live ids at a glance (run `rmwavgb3a`)

| Rail | What | Id |
| --- | --- | --- |
| Metal | Acme's statement, collected through its own mandate ($24.25) | [`0xd5ebfb6a…9b1a`](https://testnet.metalntwx.com/tx/0xd5ebfb6a9cc6638c8d9badb20c0b0aa261b00b540303e3fae47f583f973d9b1a) |
| Metal | Early collection refused, refusal recorded on chain | [`0x8143f9bc…48e2`](https://testnet.metalntwx.com/tx/0x8143f9bc0ed4297e82e1900d39368ecd709f551a734f9187f4278d6c7a8948e2) |
| Metal | Mid-book collection after the CFO's $100 cap ($186.24) | [`0xc72689e8…db0b`](https://testnet.metalntwx.com/tx/0xc72689e890c1cea4f028945cc7797f9f07ed5530bd4fb6a159ca110e53acdb0b) |
| Metal | Crash-mid-pull fault: the one $20.00 pull, not repeated | [`0xb6a6361f…a355`](https://testnet.metalntwx.com/tx/0xb6a6361fa19d0f6a32e64e145526bd866d3d946b36ad9cc6779ae5e19f03a355) |
| Visa via Airi + Airwallex | Card hold $60.00, captured $48.00 | Airi mandate `mdt_sgpdll5pnho1a3b2vki` · payment intent `int_sgpvfdzq7ho1a3akbg7` |
| Airwallex | Conversions USD → SGD (all SETTLED) | `8bc6db2c-92a1-4e7a-8759-9a402e9ae2e8` · `2601a5b8-07a1-4a04-b0e2-ce1302f00624` · `de215efb-ee9e-486e-b557-b030c382d46f` |
| T:0 | Journal entries tied to the Metal collections | `je_prod_8Q1xcuSQvyGPkZkJ` (JE-10) · `je_prod_czIvKtSyTplbdJCJ` (JE-11) |
| Airwallex | **Transfer** paying T:0 vendor bill INV-20250201-1234 (USD 100.00), funded with SGD 128.94 of proven money; PAID | `e75afb28-5ef0-4bd6-a088-8907e6ef17f8` (P261110-20KVBW6) |
| T:0 | That payment, booked: debit A/P - Vendors, credit Airwallex cash | `je_prod_74eLxNGySYHPjUo6` (JE-12) |
| T:0 | A bill payment for that bill, carrying the transfer id. T:0 accepted it, but the bill came in through another connection (Ramp), and our link to it did not resolve, so T:0 still shows the bill open. The desk does not rely on T:0 for this: it asks Airwallex, which shows the bill paid (below) | our id `tab-billpay-t0_bill_prod_9a32a0da12fe3faf33e5` |
| T:0 | Globex's $80 from this run (Metal tx `0xd073…3d21`, deposit `a32ea8ce…`), written as a payment applied to no invoice, so Globex has a T:0 id and still no invoice history | payment `t0_cust_pmt_prod_90f23ed42e9848825e1b`, customer `t0_customer_prod_abf65f998a5001ff9369` |
| T:0 | Three open $150 Slack bills a week apart, written into the sandbox for the next runs to pay (owed to our own Slack vendor record) | vendor `t0_vendor_prod_1304a031646fcba3d7f4`; bills SLK-20261020, SLK-20261027, SLK-20261103 |
| T:0 | Initech's books, written into the sandbox: customer, a $60 invoice paid 5 days late (with its payment), a $400 invoice overdue since Oct 18 | customer `t0_customer_prod_32b95cfd29087b54e366`, invoices `t0_invoice_prod_204e2c557826fe478c4e`, `t0_invoice_prod_c421d82ed9d1b494d4f5` |

The vendor payout (scene 8b) was added after run `rmwavgb3a`, so it ran once on a copy of that run's state with `scripts/pay-vendor.ts`: same code, same checks (25/25). The next full run includes it as scene 8b.

1. **Acme earns terms.** Its earlier Visa payment is re-read from Airwallex; T:0 shows 3/3 invoices paid on time → net-30; its human binds a $400 line on Metal.
2. **The CFO types goals.** "Offer 3% off for paying within 10 days… no single buyer above $350… give our best customers net-90." Claude compiles two changes and flags net-90 as not expressible; code checks every change against hard rails and dry-runs each buyer. The CFO's key (separate from the key that issues Metal credentials) signs the policy together with its audit trail, and the desk verifies that signature itself, when it applies the policy and every time it loads it (a copy edited after signing is refused).
3. **Acme's agent shops** and takes the 3% discount on three orders ($218.25), because 3% for 20 days early is about 56% a year against its 12% cost of capital.
4. **Globex is new: no invoices, no payments with Northwind.** Its agent puts $60 on a 7-day tab secured by a Visa authorisation (passkey approved). Delivery QA flags one batch stale: a $12 credit note. At due, **$48 is captured of the $60 authorised**. That verified payment is Globex's first record with Northwind and earns it the first rung of credit, net-7 (net-30 needs three invoices paid on time), and its agent buys 2,000 queries for $80.00 on net-7.
5. **Initech** is overdue in the books → prepay only; orders asking for terms it is not offered (net-30, or a card payment over the $200 cap) are refused by code.
6. **Dispute before money moves.** Claude reads the complaint; code declines the price claims with the order record, credits only the units Northwind's own QA flagged, at the price Acme was charged (200 × 3.88¢ = $7.76), and sends anything it cannot decide, such as a separate refund request, to a person.
7. **Mid-book, the CFO tightens.** With both tabs open: "a large customer just failed to pay another supplier… until month end, no single buyer may owe us more than $100." Claude caps both limits at $100 and flags "until month end" as not expressible (a person restores it). The dry run shows Acme owing $210.49 against the new $100 cap and "would collect $186.24 now"; once the signed policy is applied, the desk collects exactly that on chain (whole orders, oldest first). Globex's $80 is under the cap and untouched.
8. **The statement is the mandate.** Acme's remaining $24.25 is a statement that is its own Metal mandate: an early collection is refused on chain, the on-time one pays, a replay under a fresh payment id is refused on chain.
9. **Globex's human cuts its line**; the desk collects the $80.00 tab at once.
10. **Settle and book.** All three collections go into Airwallex and convert to SGD; Acme's two are posted to T:0 as balanced journal entries.
11. **Pay the vendor, once, from proven money.** Northwind reads its open vendor bills from T:0. Code pays the oldest one that the proven SGD covers (keeping a floor back) with one Airwallex transfer funded in SGD and paid in USD, books it in T:0, and sends the bills bigger than proven money covers to a person. Before deciding, it asks Airwallex which open bills are already paid: a live transfer under the bill's request id (which names only the bill, in every run) or with the bill's number, amount and payee. Those are refused, and their money is not set aside again, even when T:0 still shows them open. The same bill is never paid twice, across retries and runs.
12. **Every dollar proven.** For each buyer: charged − credits = collected + open − credit owed; no order collected twice; one transaction per payment id; card captures = what was owed after credits; credits re-priced at the charged unit price; and live: every collection's transfer log moved exactly its amount from the buyer to Northwind, every recorded refusal was sent by Northwind, every settlement matches a collection and its conversion SETTLED, every card capture matches Airwallex, every T:0 entry balances and equals what was collected.

**Try to make TAB double-charge.** Start the screen with `ALLOW_FAULTS=1` and press the buttons: re-send the paid statement (the desk answers from its own record and sends nothing), re-collect it under a fresh payment id, or collect $1 more (both go to Metal testnet, where the statement's mandate refuses them), or **pay the vendor bill again** (the desk's lock refuses it, and Airwallex answers with the original transfer), or **kill the desk mid-pull on the credit line**: a small order goes on Acme's tab, the pull reaches Metal, and the desk dies before recording the answer; a statement can't take the order while the pull is in flight, and the restarted desk takes the payment from the chain instead of sending it again. The buyer's balance is read before and after, and the proof re-runs.

## What is simulated or labelled

- **Whose books are whose.** Acme is mapped to an existing T:0 sandbox customer (Zephyr Metrics AB, 3/3 paid on time). Initech's history was written into the T:0 sandbox by us (`scripts/t0-seed-buyers.ts`, with a T:0 key issued for a custom API connection), and the desk reads it back from T:0 like any other customer's. Globex is a T:0 customer with no invoices. T:0 returns a customer only once a transaction links to it, so we also wrote the $80 Globex really paid in run `rmwavgb3a` (never booked until then) as a payment applied to no invoice. The credit check reads invoices only, so Globex is still a buyer with no history, and later runs can post its collection as a journal entry naming it. The three $150 Slack bills for the vendor payout were written the same way, so runs after `rmwavgb3a` pay bills that sit in the books before the run starts. Run `rmwavgb3a` predates this and read Globex and Initech from the labelled stand-in (`fixtures/standin-books.json`, the same history), which the desk still uses for Initech if T:0 does not return it.
- Airwallex deposits are sandbox simulations (the sandbox cannot receive stablecoins); quotes, conversions and card payments are real sandbox calls.
- Due dates are compressed to minutes so the video can show them.
- Stale units are set by the demo script (standing in for delivery QA).
- Testnet balances above the faucet's 100 USDZ are moved in by `scripts/top-up-buyer.ts`.
- Claude's wording and choices vary between runs (which payment option an agent picks, how an email splits into claims). Whatever it chooses, prices, limits, credits and refusals come from code.

## Run it

Node ≥ 22.13.

```bash
npm install
```

```bash
cp .env.example .env
```

Fill `.env` (Airwallex sandbox keys, your Metal testnet RPC URL, the two T:0 keys: one that reads and posts journal entries, one issued for a custom API connection that writes records; Claude provider). Write the demo buyers' books into T:0 once with `npx tsx scripts/t0-seed-buyers.ts`. Key files live in `keys/` (git-ignored): the supplier wallet, the supplier issuer key, and the buyers' owner keys created with `metal-agent account create`. Airi keeps its own login (`airi-cli auth login`). Create the CFO's policy-signing key once (kept in `keys/`, separate from the Metal issuer key):

```bash
npx tsx scripts/create-policy-key.ts
```

```bash
npm test
```

```bash
npx tsx scripts/demo-run.ts
```

```bash
LIVE_VIC=1 npx tsx scripts/demo-run.ts
```

```bash
npm run screen
```

```bash
ALLOW_FAULTS=1 npm run screen
```

Smaller tools: `scripts/try-cfo-policy.ts` (compile goals, no money moves), `scripts/try-buyer-agents.ts`, `scripts/try-dispute.ts`, `scripts/vic-statement.ts`, `scripts/settle-metal.ts`.

## Code map

| Path | What it does |
| --- | --- |
| `src/domain/credit.ts` | Credit engine in integer cents: terms, limit = min(terms cap, mandate headroom, balance), collect / escalate |
| `src/terms/offers.ts` | Catalogue and payment options (card, card-secured tab, net-7, net-30, early-pay discount) |
| `src/desk/desk.ts` | The supplier desk: orders, evaluations, collections, statements, card tabs, credits, policy |
| `src/policy/policy.ts` | CFO goals → Claude proposal → rails → signed policy |
| `src/agents/buyer.ts` | Claude buyer agents with typed tools and their own company's limits in code |
| `src/disputes/` | Claude reads the email; `decide.ts` decides credits from the order record |
| `src/visa/card-statement.ts` | Authorise at issue, capture the undisputed amount |
| `src/metal/agent.ts` | metal-agent CLI wrapper: credentials, binds, pulls, recorded refusals |
| `src/settlement/bridge.ts` | Airwallex deposit → reserve → quote → conversion, idempotent |
| `src/books/books.ts` | T:0 via MCP (history, journal entries) and the stand-in |
| `src/books/desk-books.ts` · `src/books/t0records.ts` | Which books answer for each buyer; records written into T:0 (customers, invoices, payments, vendors, bills, bill payments) |
| `src/proof/checker.ts` | "Every dollar proven": book invariants and live checks |
| `src/server/` | Demo screen (SSE) and the fault buttons |

`proofs/` holds a verified write-up for each live milestone.
