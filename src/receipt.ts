// Round receipts (plan v2 section 5): everything needed to recompute a round's winner and every share, hashed and
// written on-chain in a memo. Anyone can re-run `checkReceipt` with this public code and compare.

import { createHash, createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { applyTrade, deadline, emptyRound, type GameRules, type Round, type Trade } from "./game.js";
import { splitPot, type SplitBps } from "./split.js";

export type ReceiptBuy = { sig: string; slot: number; ts: number; wallet: string; lamports: string; tokens: string };
export type ReceiptReferral = { wallet: string; referrer: string; boundAt: number; message: string; signature: string };

export type Receipt = {
  v: 1;
  game: "BOMB";
  mint: string;
  /** The coin's PumpSwap pool, where its trades happen after graduation. */
  pool: string;
  round: number;
  rules: { minBuyLamports: string; startSeconds: number; addSeconds: number; maxSeconds: number };
  split: SplitBps;
  teamWallets: string[];
  /** What the pot could hand out when the round closed (balance minus reserve minus earlier rounds' unpaid shares). */
  available: string;
  /** Qualifying buys, in on-chain order. */
  buys: ReceiptBuy[];
  /** Token balance of every buyer when the round was split. The one input the chain can't replay later. */
  balances: Record<string, string>;
  /** Every referral binding used, with the signed message so anyone can check it. */
  referrals: ReceiptReferral[];
  winner: string | null;
  shares: { wallet: string; kind: "win" | "div" | "ref"; lamports: string }[];
  rollover: string;
};

/** Stable JSON: object keys sorted, so the same receipt always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const receiptHash = (r: Receipt) => createHash("sha256").update(canonicalJson(r)).digest("hex");
export const receiptMemo = (r: Receipt) => `BOMB r${r.round} receipt sha256:${receiptHash(r)}`;

/** The exact text a wallet signs to bind a referrer. The site and server build the same string. */
export const referralMessage = (wallet: string, referrer: string, issuedAt: number) =>
  `Last Ape Wins referral\nMy wallet: ${wallet}\nReferred by: ${referrer}\nIssued: ${issuedAt}`;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Checks a Solana wallet's ed25519 signature (base58) over `message`. */
export function verifyWalletSignature(wallet: string, message: string, signatureB58: string): boolean {
  try {
    const pub = Buffer.from(bs58.decode(wallet));
    if (pub.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(bs58.decode(signatureB58)));
  } catch {
    return false;
  }
}

const rulesOf = (r: Receipt): GameRules => ({ ...r.rules, minBuyLamports: BigInt(r.rules.minBuyLamports) });
const toTrade = (b: ReceiptBuy): Trade => ({ ...b, side: "buy", lamports: BigInt(b.lamports), tokens: BigInt(b.tokens) });

/**
 * Re-runs a round from its receipt: the timer, the winner, the referral signatures and the split.
 * Returns the problems found; an empty list means the receipt is consistent with the published rules.
 * (Whether the buys match the chain is checked separately, by `scripts/verify-round`.)
 */
export function checkReceipt(r: Receipt): string[] {
  const problems: string[] = [];
  const rules = rulesOf(r);
  const team = new Set(r.teamWallets);

  // 1. Every buy qualifies, none is a team wallet, and each landed while the bomb was still lit.
  let round: Round = emptyRound();
  for (const b of r.buys.map(toTrade)) {
    if (team.has(b.wallet)) problems.push(`buy ${b.sig} is from a team wallet`);
    const res = applyTrade(round, b, rules);
    if (res.kind === "counted") round = res.round;
    else problems.push(`buy ${b.sig} ${res.kind === "ignored" ? "doesn't qualify" : "came after the bomb went off"}`);
  }

  // 2. Winner: the last buyer still holding at least what that buy got them.
  const bal = (w: string) => BigInt(r.balances[w] ?? "0");
  let winner: string | null = null;
  for (let i = round.buys.length - 1; i >= 0; i--) {
    const b = round.buys[i]!;
    if (bal(b.wallet) >= b.tokens) {
      winner = b.wallet;
      break;
    }
  }
  if (winner !== r.winner) problems.push(`winner should be ${winner ?? "nobody"}, receipt says ${r.winner ?? "nobody"}`);

  // 3. Referral bindings: real signatures over the right text.
  const refs = new Map<string, ReceiptReferral>();
  for (const ref of r.referrals) {
    const issued = Number(/Issued: (\d+)$/.exec(ref.message)?.[1]);
    if (ref.message !== referralMessage(ref.wallet, ref.referrer, issued)) problems.push(`referral for ${ref.wallet}: message isn't the standard text`);
    else if (!verifyWalletSignature(ref.wallet, ref.message, ref.signature)) problems.push(`referral for ${ref.wallet}: bad signature`);
    else refs.set(ref.wallet, ref);
  }

  // 4. The split, recomputed.
  const res = splitPot({
    available: BigInt(r.available),
    buys: round.buys,
    winner: r.winner,
    balances: new Map(Object.entries(r.balances).map(([w, v]) => [w, BigInt(v)])),
    referrerOf: (w, ts) => {
      const ref = refs.get(w);
      return ref && ref.boundAt <= ts ? ref.referrer : null;
    },
    bps: r.split,
  });
  const key = (s: { wallet: string; kind: string; lamports: bigint | string }) => `${s.kind}:${s.wallet}:${s.lamports}`;
  const want = new Set(res.shares.map(key));
  const got = new Set(r.shares.map(key));
  for (const k of want) if (!got.has(k)) problems.push(`missing share ${k}`);
  for (const k of got) if (!want.has(k)) problems.push(`unexpected share ${k}`);
  if (res.rollover.toString() !== r.rollover) problems.push(`rollover should be ${res.rollover}, receipt says ${r.rollover}`);
  return problems;
}

/** When the round's bomb went off, from its receipt (for finding its buys on chain). */
export function receiptDeadline(r: Receipt): number | null {
  let round: Round = emptyRound();
  for (const b of r.buys.map(toTrade)) {
    const res = applyTrade(round, b, rulesOf(r));
    if (res.kind === "counted") round = res.round;
  }
  return deadline(round, rulesOf(r));
}
