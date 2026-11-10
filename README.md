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
| **Airwallex** (sandbox) | Reads back every card payment before it counts; settles each collection (deposit → refund reserve → FX quote → conversion to SGD). |
| **T:0** (sandbox) | Payment history decides net-30 vs net-7 vs prepay; every settled collection is posted as a balanced journal entry tied to its Metal tx. |

The rules that never move: no credit before a Visa-verified payment, and each payment counts once, for one buyer; when the buyer's human lowers their mandate (or the buyer is demoted to prepay) the desk collects the whole tab at once, while any other drop in the limit collects only the excess; orders are never split to dodge the $200 card cap; credits are priced at what the buyer actually paid.

## The demo (one live run, every id real)

`LIVE_VIC=1 npx tsx scripts/demo-run.ts` plays the story; `npm run screen` shows it live. **No keys needed to look:** [`docs/index.html`](docs/index.html) replays the verified run event by event (play, step, jump to a scene), with every Metal transaction linked to the public testnet explorer; rebuild it from a new run with `npm run replay -- <deskFile> <logFile>`. Full ids and the after-run re-checks: [`proofs/demo-run.md`](proofs/demo-run.md) (run `rmwavgb3a`, 21/21 checks).

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
11. **Every dollar proven.** For each buyer: charged − credits = collected + open − credit owed; no order collected twice; one transaction per payment id; card captures = what was owed after credits; credits re-priced at the charged unit price; and live: every collection's transfer log moved exactly its amount from the buyer to Northwind, every recorded refusal was sent by Northwind, every settlement matches a collection and its conversion SETTLED, every card capture matches Airwallex, every T:0 entry balances and equals what was collected.

**Try to make TAB double-charge.** Start the screen with `ALLOW_FAULTS=1` and press the buttons: re-send the paid statement (the desk answers from its own record and sends nothing), re-collect it under a fresh payment id, or collect $1 more (both go to Metal testnet, where the statement's mandate refuses them), or **kill the desk mid-pull on the credit line**: a small order goes on Acme's tab, the pull reaches Metal, and the desk dies before recording the answer; a statement can't take the order while the pull is in flight, and the restarted desk takes the payment from the chain instead of sending it again. The buyer's balance is read before and after, and the proof re-runs.

## What is simulated or labelled

- Globex's and Initech's books are a labelled stand-in (`fixtures/standin-books.json`: Globex has no history, Initech has an overdue invoice): the T:0 sandbox has no matching customers and this key cannot create records. Acme's books are real T:0 records.
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

Fill `.env` (Airwallex sandbox keys, your Metal testnet RPC URL, T:0 key, Claude provider). Key files live in `keys/` (git-ignored): the supplier wallet, the supplier issuer key, and the buyers' owner keys created with `metal-agent account create`. Airi keeps its own login (`airi-cli auth login`). Create the CFO's policy-signing key once (kept in `keys/`, separate from the Metal issuer key):

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
| `src/proof/checker.ts` | "Every dollar proven": book invariants and live checks |
| `src/server/` | Demo screen (SSE) and the fault buttons |

`proofs/` holds a verified write-up for each live milestone.
