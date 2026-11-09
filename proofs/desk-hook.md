# Supplier desk, live hook scenario (Metal testnet, 2026-11-09)

Run with `npx tsx scripts/demo-hook.ts`. Chain calls are real; the receivables history comes from the **labelled stand-in books** (`fixtures/standin-books.json`) until the T:0 key works. Buyer account `0x4d0a5161AbA00FB71397675a1919163d6e7cEd33`, supplier payee `0x6C7578104c945e6A0b21eD9f022abE197a40B6B4`.

| Step | Desk decision / result | Transaction |
| --- | --- | --- |
| Supplier issues mandate `0x8d55652e…d8fdab` (budget 9.00, cap 5.00); Acme's owner binds it | — | `0x72cedc464ae5a01bb3459817c1c64f9ebdba4725b7646343687decc591c8a1bd` |
| 3 agent orders: 0.60, 0.70, 0.50 | NET_30, limit $9.00 → each order **on the tab** | — |
| Acme's human cuts the budget to 2.50 (replacement `0x46894941…08715f`, same pull key) | — | `0xcc0548b1d0e17fd15ec00c671c99f1ac31b5b32cbc41a658b44da0be0e47a3f7` |
| Desk re-evaluates | limit tightened $9.00 → $2.50 → **collect all**: one pull of $1.80 for orders o1–o3, payment-id `0x56089fd7…` = hash of those orders | `0xdb5a77f29b081db0a906367bb38b407ad778574121c6b72fded4369ecc7825cc` |
| Agent orders 1.00 more | limit now $0.70 → **prepay by VIC card** | — |
| `mandate verify --tx` on the collection | all 4 steps pass, `verified yes` | — |

Note: a mandate's budget never resets, so every collection uses up credit capacity. Ongoing terms need the supplier to issue a fresh credential each period (`mandate renew` starts spend at zero).
