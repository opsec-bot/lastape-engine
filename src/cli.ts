#!/usr/bin/env node
// Checks a round with public data only: npx tsx src/cli.ts <round> [site] [rpc]
import { verifyRound } from "./checker.js";

const [roundArg, site = "https://lastape.fun", rpcUrl = "https://solana-rpc.publicnode.com"] = process.argv.slice(2);
const round = Number(roundArg);
if (!Number.isInteger(round) || round < 1) {
  console.error("usage: verify-round <round> [site] [rpc]");
  process.exit(2);
}
const res = await verifyRound({ site, round, rpcUrl, log: (m) => console.error(`  ${m}`) });
console.log(`Round ${round} on ${site}`);
for (const l of res.lines) console.log(l);
console.log(res.ok ? "\nRound checks out." : "\nRound does NOT check out.");
process.exit(res.ok ? 0 : 1);
