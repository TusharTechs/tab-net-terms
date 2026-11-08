# Metal testnet: supplier-held debit mandate (run 2026-11-08)

Network: Metal testnet, chain id 63825. Tooling: `@metalntwx/metal-agent` 0.3.3. Every hash below opens at `https://testnet.metalntwx.com/tx/<hash>`.

| Role | Address |
| --- | --- |
| Buyer account (principal) | `0x4d0a5161AbA00FB71397675a1919163d6e7cEd33` |
| Buyer owner key | `0x5846a7e39F5Bc55599Fc6498De082568ee66A766` |
| Supplier wallet (payee) | `0x6C7578104c945e6A0b21eD9f022abE197a40B6B4` |

The supplier issued each credential with its own issuer key and its own pull (mandate) key; the buyer's owner bound it, trusting only the supplier's public issuer file.

| Step | Result | Transaction |
| --- | --- | --- |
| Buyer binds v1 (`0x76e9107f…3e11c7`): cap 5, budget 9, payee = supplier | bound | `0x1e8a23157ded841d9cbef44151e3110c384bf41b2b7c3e03136c9d03b6136445` |
| Buyer account funded from faucet | 100 USDZ | `0xd7b6ff2c60f56c66201567b6d436e0717368a1169cac7dfe57d1ebb80fd172ff` |
| Supplier pulls 1.80 (payment-id = hash of order batch INV-0001) | paid, spent 1.8 / 9 | `0x7beba4d475cbb256ea533d5b585845671c3999527d51d7d67200e2b80a1bbaff` |
| Same pull repeated | "already paid, nothing sent" | same as above |
| Buyer replaces v1 with v2 (`0xceae4912…f01164`), budget 2.50, same pull key | v1 revoked, spent carried over: 1.8 / 2.5 | `0x96993474656055eedb133f031f51451bfffc264544a2680a25d8fe6fd2d5b38d` |
| Supplier pulls 0.50 under revoked v1 | refused `mandate_revoked`, nothing sent | — |
| Supplier pulls 1.00 under v2 (0.70 left) | refused `mandate_budget_spent`, nothing sent | — |
| Supplier pulls 0.70 under v2 | paid, spent 2.5 / 2.5 | `0x226c3733ed9f942d0ba95d484fed34f8a9ef9f4530177585a7446fdbbe43ee12` |
| `mandate verify` on v2 and on each pull, against the supplier's issuer key | all 4 steps pass, `verified yes` | — |

Notes:
- `mandate status --credential <file>` showed bound/revoked/spent/payments for both credentials without any buyer key.
- Duplicate protection for `--payment-id` is recorded locally (`~/.metal-agent/pulls`, per the CLI help); the on-chain nonce did not match a plain keccak of the payment-id, so TAB keeps its own ledger mapping order batch → payment-id → tx hash.
- Refusals above were not recorded on chain (`--record-refusal` needs a funded `--key`).
