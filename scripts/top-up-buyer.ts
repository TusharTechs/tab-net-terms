/**
 * Testnet only: raise a buyer account's USDZ above the faucet's 100 ceiling, so demo tabs can be
 * hundreds of dollars. A helper account (its own owner key) is refilled by the faucet and moves
 * funds to the buyer with a self-issued mandate pull. Each round costs one faucet call.
 *   npx tsx scripts/top-up-buyer.ts <buyerAccount> <rounds>
 */
import { existsSync } from "node:fs";
import { config } from "../src/config.js";
import { MetalAgent, usdzBalance } from "../src/metal/agent.js";

const [buyer, roundsArg] = process.argv.slice(2);
if (!buyer) throw new Error("usage: top-up-buyer.ts <buyerAccount> <rounds>");
const rounds = Number(roundsArg ?? 3);
const cfg = config();
const rpc = cfg.METAL_RPC_URL!;
const metal = new MetalAgent();
const OWNER = "keys/helper-owner.json";
const CRED = "keys/helper-to-buyer.json";

const helper = await metal.createAccount(OWNER, existsSync(OWNER));
console.log(`helper account ${helper.account}`);
if (!existsSync(CRED)) {
  // Helper's owner issues and binds its own mandate: payee = the buyer account.
  const run = (await import("node:child_process")).execFileSync;
  run("node_modules/.bin/metal-agent", ["mandate", "credential", "create", "--principal", helper.account, "--cap", "99", "--budget", "5000", "--key", OWNER, "--payee", buyer, "--out", CRED, "--network", "testnet"], { stdio: "inherit", env: process.env });
  run("node_modules/.bin/metal-agent", ["mandate", "bind", "--credential", CRED, "--key", OWNER, "--network", "testnet"], { stdio: "inherit", env: process.env });
}
for (let i = 1; i <= rounds; i++) {
  await metal.fund(helper.account);
  const bal = await usdzBalance(rpc, helper.account);
  const amount = Math.min(9_900, bal - 100);
  if (amount <= 0) break;
  const r = await metal.pull({ credential: CRED, mandateKeyFile: CRED.replace(".json", ".key.json"), to: buyer, amount, paymentId: `0x${Date.now().toString(16)}${i}` });
  console.log(`round ${i}: moved $${(amount / 100).toFixed(2)} → ${r.outcome}${"tx" in r && r.tx ? ` tx ${r.tx}` : ""}`);
}
console.log(`buyer balance now $${((await usdzBalance(rpc, buyer)) / 100).toFixed(2)} USDZ`);
