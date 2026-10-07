// Checks one round end to end with nothing but public data: the receipt from the site, the memo on-chain, and the
// coin's trades on-chain. Plain fetch + JSON-RPC, no wallet, no keys. Run it with `verify-round`.

import { decodeLogs } from "./pump/events.js";
import { qualifies, tradesFrom, type Trade } from "./game.js";
import { checkReceipt, receiptDeadline, receiptHash, receiptMemo, type Receipt } from "./receipt.js";

/** Public gateway for receipts pinned to IPFS. Any gateway works; the hash check doesn't trust it. */
export const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export function jsonRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const j = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    }
  };
}

type TxResult = { slot: number; blockTime: number | null; meta: { err: unknown; logMessages?: string[] } | null } | null;
const getTx = (rpc: Rpc, sig: string) =>
  rpc("getTransaction", [sig, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 1 }]) as Promise<TxResult>;

export type CheckResult = { ok: boolean; lines: string[] };

/**
 * 1. The receipt follows the rules (timer, winner, referral signatures, split).
 * 2. Its hash is in the memo transaction the site points to.
 * 3. Its buys are exactly the coin's qualifying buys on-chain during the round.
 */
export async function verifyRound(opts: { site: string; round: number; rpcUrl: string; fetchImpl?: typeof fetch; log?: (m: string) => void }): Promise<CheckResult> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const lines: string[] = [];
  let ok = true;
  const fail = (m: string) => {
    ok = false;
    lines.push(`FAIL ${m}`);
  };
  const pass = (m: string) => lines.push(`ok   ${m}`);

  const res = await f(`${opts.site.replace(/\/$/, "")}/api/rounds/${opts.round}/receipt`);
  if (!res.ok) return { ok: false, lines: [`FAIL couldn't get the receipt (${res.status})`] };
  const { receipt, receiptSig, receiptCid } = (await res.json()) as { receipt: Receipt; receiptSig: string | null; receiptCid?: string | null };

  // 1. Rules.
  const problems = checkReceipt(receipt);
  if (problems.length) problems.forEach(fail);
  else pass(`rules: ${receipt.buys.length} buys, winner ${receipt.winner ?? "nobody"}, ${receipt.shares.length} shares, split recomputes exactly`);

  const rpc = jsonRpc(opts.rpcUrl, f);

  // 2a. The IPFS copy: the same receipt, independent of the site.
  if (receiptCid) {
    const copy = await f(`${IPFS_GATEWAY}${receiptCid}`).then((r) => (r.ok ? (r.json() as Promise<Receipt>) : null)).catch(() => null);
    if (!copy) lines.push(`--   couldn't reach the IPFS copy (${receiptCid}) right now`);
    else if (receiptHash(copy) === receiptHash(receipt)) pass(`IPFS copy ${receiptCid} is the same receipt`);
    else fail(`IPFS copy ${receiptCid} differs from the site's receipt`);
  } else lines.push("--   no IPFS copy for this round");

  // 2. The memo.
  if (!receiptSig) fail("no memo transaction yet");
  else if (receiptSig.startsWith("sim-")) lines.push("--   demo round: its memo was simulated, nothing on-chain to compare");
  else {
    const tx = await getTx(rpc, receiptSig);
    const want = receiptMemo(receipt);
    if (tx?.meta?.logMessages?.some((l) => l.includes(want))) pass(`memo ${receiptSig} carries this receipt's hash`);
    else fail(`memo ${receiptSig} doesn't carry "${want}"`);
  }

  // 2b. The airdrop draw's block: really on-chain, really the first block after the bomb went off.
  const boom = receiptDeadline(receipt);
  const a = receipt.airdrop;
  if (a?.slot !== null && a?.slot !== undefined && a.blockhash && boom !== null) {
    const block = (await rpc("getBlock", [a.slot, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }])) as { blockhash: string; blockTime: number | null } | null;
    const before = (await rpc("getBlocks", [Math.max(0, a.slot - 500), a.slot - 1, { commitment: "finalized" }])) as number[];
    const prevTime = before.length ? ((await rpc("getBlockTime", [before.at(-1)])) as number | null) : null;
    if (!block || block.blockhash !== a.blockhash) fail(`airdrop: block ${a.slot} has a different hash than the receipt says`);
    else if (block.blockTime === null || block.blockTime <= boom) fail(`airdrop: block ${a.slot} isn't after the bomb went off`);
    else if (prevTime === null || prevTime > boom) fail(`airdrop: block ${a.slot} isn't the first block after the bomb went off`);
    else pass(`airdrop: drawn from block ${a.slot}, the first block after the bomb went off (${a.hit ? `hit, won by ${a.winner ?? "nobody"}` : "missed"})`);
  } else lines.push("--   no airdrop draw recorded for this round");

  // 3. The buys, against the chain.
  const end = receiptDeadline(receipt);
  const first = receipt.buys[0];
  if (!first || end === null) {
    lines.push("--   no buys to check against the chain");
    return { ok, lines };
  }
  const coin = { mint: receipt.mint, pool: receipt.pool };
  const rules = { minBuyLamports: BigInt(receipt.rules.minBuyLamports), startSeconds: receipt.rules.startSeconds, addSeconds: receipt.rules.addSeconds, maxSeconds: receipt.rules.maxSeconds };
  const team = new Set(receipt.teamWallets);
  const onChain: Trade[] = [];
  let before: string | undefined;
  // Walk the coin's history back from now until we're before the round's first buy.
  for (let page = 0; page < 200; page++) {
    const sigs = (await rpc("getSignaturesForAddress", [receipt.mint, { limit: 1000, before, commitment: "confirmed" }])) as { signature: string; blockTime: number | null; err: unknown }[];
    if (!sigs.length) break;
    for (const s of sigs) {
      if (s.err || s.blockTime === null || s.blockTime < first.ts || s.blockTime > end) continue;
      const tx = await getTx(rpc, s.signature);
      if (!tx?.meta || tx.meta.err) continue;
      for (const t of tradesFrom(decodeLogs(tx.meta.logMessages ?? []).events, s.signature, tx.slot, coin)) {
        if (qualifies(t, rules) && !team.has(t.wallet) && t.ts >= first.ts && t.ts <= end) onChain.push(t);
      }
    }
    log(`read ${sigs.length} transactions back to ${new Date((sigs.at(-1)!.blockTime ?? 0) * 1000).toISOString()}`);
    if ((sigs.at(-1)!.blockTime ?? 0) < first.ts) break;
    before = sigs.at(-1)!.signature;
  }
  const key = (b: { sig: string; wallet: string; lamports: bigint | string }) => `${b.sig}:${b.wallet}:${b.lamports}`;
  const chainKeys = new Set(onChain.map(key));
  const receiptKeys = new Set(receipt.buys.map(key));
  const missing = [...chainKeys].filter((k) => !receiptKeys.has(k));
  const extra = [...receiptKeys].filter((k) => !chainKeys.has(k));
  missing.forEach((k) => fail(`on-chain buy missing from the receipt: ${k}`));
  extra.forEach((k) => fail(`receipt buy not found on-chain: ${k}`));
  if (!missing.length && !extra.length) pass(`buys: all ${receipt.buys.length} match the chain, none left out`);
  lines.push("--   balances are as read when the round closed; the chain can't replay them later");
  return { ok, lines };
}
