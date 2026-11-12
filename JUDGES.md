# TAB: judges' guide

**TAB gives AI buyer agents net terms.** A supplier's credit desk decides who gets terms, secures them on Metal or with a Visa card hold through Airi, collects on time, settles through Airwallex, books in T:0, and proves every dollar. Claude reads text and runs the buyer agents; code and the chain decide every amount.

Airwallex Agentic Banking Hackathon · team Four Eyes, One Human · run `rmwbpgwbj`, 11 Nov 2026

## In 2 minutes

1. **Watch** the demo video (4:50): https://youtu.be/_LsjxwVXuac. Key moments: [Visa-secured tab 1:44](https://youtu.be/_LsjxwVXuac?t=104) · [Metal statement mandate 2:52](https://youtu.be/_LsjxwVXuac?t=172) · [Airwallex vendor payout 3:30](https://youtu.be/_LsjxwVXuac?t=210) · [26/26 proof 3:50](https://youtu.be/_LsjxwVXuac?t=230).
2. **Open** the live project: https://main.d1k1s0hwodmj8i.amplifyapp.com (the desk screen replaying the run; press **Take the tour**).
3. **Click** three Metal testnet transactions from the run:
   - the statement collected through its own mandate: [`0x747b…2baa`](https://testnet.metalntwx.com/tx/0x747b21ed394e3ec6f9de96f7f2e31e9187fa2829b76cfe780a60a13373ae2baa)
   - the early collection, refused and recorded on chain: [`0x24ce…5c0b`](https://testnet.metalntwx.com/tx/0x24ce402afb5119a292f8c8d31095650cb43efee5ffa20abaa718d2408e665c0b)
   - the second collection, refused and recorded on chain: [`0x846e…65fa`](https://testnet.metalntwx.com/tx/0x846e31d8684c0e528acd29253be9db1558166471c0bb0df632067b744e8a65fa)

## In 10 minutes: check the claims yourself

| Claim | Check it here |
| --- | --- |
| A statement is its own Metal mandate; early and repeat collections are refused on chain and recorded by the supplier | The three transactions above; `src/desk/desk.ts`; `test/statements.test.ts` |
| A new buyer's tab is secured by a passkey-approved Airi mandate; only the undisputed $48.00 of $60.00 is captured, then read back | Airi mandate `mdt_sgpdtm62gho1x9c3g3c`, payment intent `int_sgpvfdzq7ho1x9bqqdg`; `src/visa/card-statement.ts`; `test/card-capture.test.ts` |
| No credit before a Visa-verified payment | `requireVicBeforeCredit` in `src/domain/credit.ts`; `test/credit.test.ts` |
| Collections settle in Airwallex (refund reserve, FX USD → SGD 351.68) | Conversions `34cc070a…`, `5a9efcad…`, `55583dd4…` (SETTLED); `src/settlement/bridge.ts` |
| A vendor bill is paid once, only from proven money; an already-paid bill is refused | Airwallex transfer `P261111-ENB0OZO` (PAID) and `P261110-20KVBW6`; `src/payout/vendor.ts`; `test/payout.test.ts` |
| Every collection and the payout are balanced journal entries in T:0 | JE-13, JE-14, JE-15, JE-16; `src/books/books.ts` |
| The model never decides money | `src/policy/policy.ts` (rails reject, never clamp), `src/disputes/decide.ts` (credits from the order record), `src/agents/buyer.ts` (four typed tools) |
| Every dollar proven: 26/26 | [`proofs/demo-run.md`](proofs/demo-run.md); `src/proof/checker.ts` |
| It runs | `npm install` then `npm test`: 139 tests, no keys needed (Node 22.13+) |

## Fit for each award

- **Metal Award (Metal + Airwallex):** credit lines and statements are Metal debit mandates bound by the buyer's human; the chain enforces amount, count and due window; refusals are recorded on chain; a cut line is honoured at once; every Metal collection settles into Airwallex.
- **Visa Award (VIC via Airi + Airwallex):** a stranger becomes a customer through a passkey-approved Airi mandate and an Airwallex Payment Acceptance pre-authorisation; only what is owed is captured and read back; that verified payment is what earns credit.
- **Founder's and Judges' Choice:** agents buying on credit, from the seller's side, with the decision changing as balance, deadline, evidence and risk change, and ending in real money movements on four rails plus a proof of every dollar. The README maps each point of Airwallex's builder guide to the code and the run.

## Labelled, not hidden

- Initech's and Globex's books and the Slack bills were written into the T:0 sandbox by us, through a custom API connection.
- Airwallex deposits are sandbox simulations (the sandbox cannot receive stablecoins); quotes, conversions, card payments and the transfer are real sandbox calls; the transfer goes to a beneficiary with sandbox bank details and is moved to PAID by the sandbox's simulation call.
- Due dates are compressed to minutes so the video can show them.
- The buyers' owner keys are key files run by the demo script, standing in for each buyer's human.
- The video and the live project replay one recorded live run; every id is listed so each can be checked.

## In the release

| File | What it is |
| --- | --- |
| `TAB-demo-video.mp4` | The demo video (4:50, 1080p) |
| `TAB-judges-guide.pdf` | This guide |
| `TAB-live-replay.html` | The live project as one file: open it in any browser, offline |
| `TAB-run-rmwbpgwbj-evidence.zip` | The run's raw evidence: the desk's event log, the backend log, the Airwallex and T:0 read-backs, the Metal explorer pages, and every proof write-up |
| `TAB-thumbnail.png` | The video's thumbnail |
| `SHA256SUMS.txt` | Checksums for every file above |

Code: https://github.com/TusharTechs/tab-net-terms · how to run it: the README's "Run it locally" section.
