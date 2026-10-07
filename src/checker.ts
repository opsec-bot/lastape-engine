// Checks one round end to end with nothing but public data: the receipt from the site, the memo on-chain, and the
// coin's trades on-chain. Plain fetch + JSON-RPC, no wallet, no keys. Run it with `verify-round`.

import { decodeLogs } from "./pump/events.js";
import { qualifies, tradesFrom, type Trade } from "./game.js";
import { checkReceipt, receiptDeadline, receiptMemo, type Receipt } from "./receipt.js";

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
  const { receipt, receiptSig } = (await res.json()) as { receipt: Receipt; receiptSig: string | null };

  // 1. Rules.
  const problems = checkReceipt(receipt);
  if (problems.length) problems.forEach(fail);
  else pass(`rules: ${receipt.buys.length} buys, winner ${receipt.winner ?? "nobody"}, ${receipt.shares.length} shares, split recomputes exactly`);

  const rpc = jsonRpc(opts.rpcUrl, f);

  // 2. The memo.
  if (!receiptSig) fail("no memo transaction yet");
  else {
    const tx = await getTx(rpc, receiptSig);
    const want = receiptMemo(receipt);
    if (tx?.meta?.logMessages?.some((l) => l.includes(want))) pass(`memo ${receiptSig} carries this receipt's hash`);
    else fail(`memo ${receiptSig} doesn't carry "${want}"`);
  }

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
