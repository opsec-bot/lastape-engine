// How a round's pot is shared (plan v2 section 1, D17), and the airdrop side pot (D19). Pure: the caller brings
// balances, referrers and the block hash that draws the airdrop.

import { createHash } from "node:crypto";
import type { Trade } from "./game.js";

export type SplitBps = {
  /** The last qualifying buyer still holding. */
  winnerBps: number;
  /** Everyone who made a qualifying buy this round and still holds, by SOL bought ("keys"). */
  dividendBps: number;
  /** The referrers of this round's buyers, by their buyers' keys. */
  referralBps: number;
  /** Stays in the pot for the next round, along with every share nobody qualified for. */
  rolloverBps: number;
  /** Goes into the airdrop pot, which builds up until a round's draw hits (D19). */
  airdropBps: number;
};

export const DEFAULT_SPLIT_BPS: SplitBps = { winnerBps: 5000, dividendBps: 2500, referralBps: 1000, rolloverBps: 1300, airdropBps: 200 };

export function assertSplit(s: SplitBps): void {
  const parts = [s.winnerBps, s.dividendBps, s.referralBps, s.rolloverBps, s.airdropBps];
  if (parts.some((p) => !Number.isInteger(p) || p < 0)) throw new Error("split shares must be whole, non-negative bps");
  if (parts.reduce((a, b) => a + b, 0) !== 10_000) throw new Error("split must total 10000 bps");
}

export type ShareKind = "win" | "div" | "ref" | "drop";
export type Share = { wallet: string; kind: ShareKind; lamports: bigint };

export type SplitInput = {
  /** What this round can hand out: the pot minus the rent reserve and anything already owed to earlier rounds. */
  available: bigint;
  /** The round's qualifying buys (team wallets already left out). */
  buys: Pick<Trade, "wallet" | "lamports" | "tokens" | "ts">[];
  /** The winning wallet, or null when nobody qualified. */
  winner: string | null;
  /** Token balance of every buyer, read when the round closed. */
  balances: Map<string, bigint>;
  /** A buyer's referrer, if one was bound at or before the buy's block time. */
  referrerOf: (wallet: string, ts: number) => string | null;
  bps: SplitBps;
  /** The airdrop draw. Without it (or without a block hash) this round adds to the airdrop pot but draws nothing. */
  airdrop?: { round: number; pool: bigint; chanceBps: number; blockhash: string | null };
};

export type AirdropDraw = {
  /** Eligible tickets: one per qualifying buy whose wallet still holds everything it bought this round. */
  tickets: number;
  /** 0 to 9999; the airdrop hits when it's below the chance. */
  roll: number;
  hit: boolean;
  /** Index into the eligible buys (on-chain order), when it hit and there was at least one ticket. */
  ticket: number | null;
  winner: string | null;
};

export type SplitResult = {
  shares: Share[];
  rollover: bigint;
  /** What this round added to the airdrop pot. */
  airdropIn: bigint;
  /** The airdrop pot after this round (0 when it was won). */
  airdropPool: bigint;
  draw: AirdropDraw | null;
};

/**
 * The airdrop draw, from a block hash nobody could know while the round was open (the first block after the
 * bomb went off). Anyone can recompute it.
 */
export function drawAirdrop(round: number, blockhash: string, tickets: number, chanceBps: number): Pick<AirdropDraw, "roll" | "hit" | "ticket"> {
  const h = createHash("sha256").update(`BOMB airdrop|r${round}|${blockhash}`).digest();
  const roll = h.readUInt32BE(0) % 10_000;
  const hit = roll < chanceBps;
  return { roll, hit, ticket: hit && tickets > 0 ? h.readUInt32BE(4) % tickets : null };
}

/**
 * Splits `available`. Every lamport not paid out (rollover share, sellers' dividends, buyers without a
 * referrer, rounding dust) stays in the pot, so `sum(shares) + rollover === available`.
 */
export function splitPot(input: SplitInput): SplitResult {
  assertSplit(input.bps);
  const { available, buys, bps } = input;
  const pool = input.airdrop?.pool ?? 0n;
  if (available <= 0n) return { shares: [], rollover: 0n, airdropIn: 0n, airdropPool: pool, draw: null };
  const out = new Map<string, Share>();
  const add = (wallet: string, kind: ShareKind, lamports: bigint) => {
    if (lamports <= 0n) return;
    const k = `${kind}:${wallet}`;
    const s = out.get(k);
    if (s) s.lamports += lamports;
    else out.set(k, { wallet, kind, lamports });
  };

  if (input.winner) add(input.winner, "win", (available * BigInt(bps.winnerBps)) / 10_000n);

  // Keys per wallet, and the tokens each must still hold to collect (same rule as the winner).
  const keys = new Map<string, bigint>();
  const bought = new Map<string, bigint>();
  let totalKeys = 0n;
  for (const b of buys) {
    keys.set(b.wallet, (keys.get(b.wallet) ?? 0n) + b.lamports);
    bought.set(b.wallet, (bought.get(b.wallet) ?? 0n) + b.tokens);
    totalKeys += b.lamports;
  }
  if (totalKeys > 0n) {
    const divPool = (available * BigInt(bps.dividendBps)) / 10_000n;
    for (const [wallet, k] of keys) {
      if ((input.balances.get(wallet) ?? 0n) >= bought.get(wallet)!) add(wallet, "div", (divPool * k) / totalKeys);
    }
    // Referral credit is per buy: it counts only if the referrer was bound before that buy. Selling later doesn't
    // undo it; the buy still paid its fees into the pot.
    const refPool = (available * BigInt(bps.referralBps)) / 10_000n;
    const refKeys = new Map<string, bigint>();
    for (const b of buys) {
      const r = input.referrerOf(b.wallet, b.ts);
      if (r && r !== b.wallet) refKeys.set(r, (refKeys.get(r) ?? 0n) + b.lamports);
    }
    for (const [ref, k] of refKeys) add(ref, "ref", (refPool * k) / totalKeys);
  }

  // The airdrop: this round's slice goes into the pot first, then the draw may hand the whole pot to one ticket.
  const airdropIn = (available * BigInt(bps.airdropBps)) / 10_000n;
  let airdropPool = pool + airdropIn;
  let draw: AirdropDraw | null = null;
  if (input.airdrop?.blockhash) {
    const holds = (w: string) => (input.balances.get(w) ?? 0n) >= bought.get(w)!;
    const eligible = buys.filter((b) => holds(b.wallet));
    const d = drawAirdrop(input.airdrop.round, input.airdrop.blockhash, eligible.length, input.airdrop.chanceBps);
    const winner = d.ticket === null ? null : eligible[d.ticket]!.wallet;
    draw = { tickets: eligible.length, ...d, winner };
    if (winner && airdropPool > 0n) {
      add(winner, "drop", airdropPool);
      airdropPool = 0n;
    }
  }

  const shares = [...out.values()];
  const paid = shares.filter((s) => s.kind !== "drop").reduce((a, s) => a + s.lamports, 0n);
  return { shares, rollover: available - paid - airdropIn, airdropIn, airdropPool, draw };
}
