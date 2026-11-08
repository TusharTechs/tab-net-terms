/**
 * Settles real Metal testnet collections into the Airwallex sandbox using TAB's ledger
 * (data/settlements.json), then re-sends every one to show nothing moves twice. Prints ids only.
 *   npx tsx scripts/settle-metal.ts <usdGlobalAccountId> <txHash>:<usdz> [<txHash>:<usdz> ...]
 */
import { AirwallexClient } from "../src/airwallex/client.js";
import { config } from "../src/config.js";
import { fromMajor } from "../src/domain/money.js";
import { FileLedger } from "../src/ledger/settlements.js";
import { settleCollection } from "../src/settlement/bridge.js";

const [gaId, ...pairs] = process.argv.slice(2);
if (!gaId || pairs.length === 0) throw new Error("usage: settle-metal.ts <usdGlobalAccountId> <txHash>:<usdz>...");

const cfg = config();
const awx = new AirwallexClient({ baseUrl: cfg.AWX_BASE_URL, clientId: cfg.AWX_CLIENT_ID, apiKey: cfg.AWX_API_KEY });
const ledger = new FileLedger("data/settlements.json");
const refuse = async () => false; // these amounts are below the approval threshold; anything above stays unconverted

const collections = pairs.map((p) => {
  const [hash, usdz] = p.split(":");
  return { metalTxHash: hash!, amount: fromMajor(usdz!), payerName: "Acme procurement agent (Metal 0x4d0a…Ed33)" };
});

for (const [pass, list] of [["first", collections], ["repeat", collections]] as const) {
  for (const c of list) {
    const out = await settleCollection(awx, ledger, gaId, c, refuse);
    const summary = out.kind === "already_settled" ? { state: out.record.state } : out.kind === "converted" ? { depositId: out.depositId, conversionId: out.conversionId, quoteId: out.quote.quote_id } : { depositId: out.depositId, reason: out.reason };
    console.log(JSON.stringify({ pass, tx: c.metalTxHash.slice(0, 12), kind: out.kind, ...summary }));
  }
}
