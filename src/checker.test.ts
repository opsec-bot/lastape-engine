import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { verifyRound } from "./checker.js";
import { PUMP_PROGRAM_ID } from "./config.js";
import { DISCRIMINATORS } from "./pump/programs.js";
import { receiptMemo, type Receipt } from "./receipt.js";
import { DEFAULT_SPLIT_BPS, splitPot } from "./split.js";

const SOL = 1_000_000_000n;
const key = () => bs58.encode(randomBytes(32));
const MINT = key();

/** The logs of one pump buy, as the RPC returns them. */
function buyLogs(user: string, sol: bigint, tokens: bigint, ts: number) {
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
  const data = Buffer.concat([
    Buffer.from(DISCRIMINATORS.pumpTrade), Buffer.from(bs58.decode(MINT)), u64(sol), u64(tokens), Buffer.from([1]), Buffer.from(bs58.decode(user)), i64(ts),
    u64(1n), u64(1n), u64(1n), u64(1n),
  ]);
  return [`Program ${PUMP_PROGRAM_ID} invoke [1]`, `Program data: ${data.toString("base64")}`, `Program ${PUMP_PROGRAM_ID} success`];
}

function world(o: { hideBuy?: boolean; badMemo?: boolean } = {}) {
  const alice = key(), bob = key(), carol = key();
  // On chain: alice and bob play round 1; carol buys after it's over (next round).
  const chain = [
    { sig: "s1", slot: 10, ts: 1000, user: alice, sol: SOL },
    { sig: "s2", slot: 20, ts: 1500, user: bob, sol: 2n * SOL },
    { sig: "s3", slot: 30, ts: 9000, user: carol, sol: SOL },
  ];
  const listed = chain.filter((c) => !(o.hideBuy && c.sig === "s2"));
  const buys = listed.slice(0, 2).map((c) => ({ sig: c.sig, slot: c.slot, ts: c.ts, wallet: c.user, lamports: String(c.sol), tokens: "100" }));
  const balances = Object.fromEntries(buys.map((b) => [b.wallet, "100"]));
  const winner = buys.at(-1)!.wallet;
  const res = splitPot({
    available: 4n * SOL, winner, bps: DEFAULT_SPLIT_BPS, referrerOf: () => null,
    buys: buys.map((b) => ({ ...b, lamports: BigInt(b.lamports), tokens: 100n })), balances: new Map(Object.entries(balances).map(([k, v]) => [k, BigInt(v)])),
  });
  const receipt: Receipt = {
    v: 1, game: "BOMB", mint: MINT, pool: key(), round: 1,
    rules: { minBuyLamports: String(SOL / 10n), startSeconds: 1800, addSeconds: 120, maxSeconds: 1800 },
    split: DEFAULT_SPLIT_BPS, teamWallets: [], available: String(4n * SOL), buys, balances, referrals: [], winner,
    shares: res.shares.map((s) => ({ ...s, lamports: s.lamports.toString() })), rollover: res.rollover.toString(),
  };
  const memo = o.badMemo ? "BOMB r1 receipt sha256:00" : receiptMemo(receipt);
  const fetchImpl = (async (url: string, init?: { body: string }) => {
    if (url.includes("/api/rounds/1/receipt")) return Response.json({ receipt, receiptSig: "MEMO" });
    const { method, params } = JSON.parse(init!.body) as { method: string; params: [string, { before?: string }] };
    if (method === "getSignaturesForAddress") {
      if (params[1].before) return Response.json({ result: [] });
      return Response.json({ result: [...chain].reverse().map((c) => ({ signature: c.sig, blockTime: c.ts, err: null })) });
    }
    if (params[0] === "MEMO") return Response.json({ result: { slot: 40, blockTime: 9999, meta: { err: null, logMessages: [`Program log: Memo (len 9): "${memo}"`] } } });
    const c = chain.find((x) => x.sig === params[0])!;
    return Response.json({ result: { slot: c.slot, blockTime: c.ts, meta: { err: null, logMessages: buyLogs(c.user, c.sol, 100n, c.ts) } } });
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

describe("verifyRound", () => {
  it("an honest round checks out against the chain", async () => {
    const r = await verifyRound({ site: "https://x", round: 1, rpcUrl: "https://rpc", fetchImpl: world().fetchImpl });
    expect(r.lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("catches a buy left out of the receipt", async () => {
    const r = await verifyRound({ site: "https://x", round: 1, rpcUrl: "https://rpc", fetchImpl: world({ hideBuy: true }).fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.lines.some((l) => l.startsWith("FAIL on-chain buy missing from the receipt: s2"))).toBe(true);
  });

  it("catches a memo that doesn't match", async () => {
    const r = await verifyRound({ site: "https://x", round: 1, rpcUrl: "https://rpc", fetchImpl: world({ badMemo: true }).fetchImpl });
    expect(r.ok).toBe(false);
  });
});
