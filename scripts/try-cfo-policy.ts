/**
 * Dry run of "the CFO types goals": Claude compiles them, code applies the rails. Moves no money.
 *   npx tsx scripts/try-cfo-policy.ts ["goals text"]
 */
import { claude } from "../src/claude/client.js";
import { policyChangeText } from "../src/desk/desk.js";
import { applyRails, compileGoals, DEFAULT_DESK_POLICY } from "../src/policy/policy.js";

export const CFO_GOALS =
  "Cash is tight this quarter, so we want to be paid faster: offer 3% off to any buyer who pays within 10 days. Keep net-30 for buyers with a clean record, but no single buyer above $350 on credit. And give our best customers net-90.";

const goals = process.argv[2] ?? CFO_GOALS;
const { proposal, model } = await compileGoals(claude(), goals, DEFAULT_DESK_POLICY);
const r = applyRails(DEFAULT_DESK_POLICY, proposal);
console.log(`model ${model}\nsummary: ${proposal.summary}`);
for (const c of r.accepted) console.log(`  ✔ ${policyChangeText(c)}${c.cfoWords ? `  ← "${c.cfoWords}"` : ""}`);
for (const c of r.rejected) console.log(`  ✘ ${policyChangeText(c)}: ${c.why}`);
for (const n of proposal.notCompiled) console.log(`  ∅ not expressible: ${n.goal} (${n.why})`);
