// The bomb: pure round rules (PLAN "Round rules", decisions D4, D5). No I/O here, so every rule is testable.

import type { PumpEvent } from "./pump/events.js";

export type GameRules = {
  /** A buy of at least this many lamports counts: it adds time and takes the lead (D5: 0.1 SOL). */
  minBuyLamports: bigint;
  /** The first qualifying buy lights the bomb with this much time. */
  startSeconds: number;
  /** Every later qualifying buy adds this much (Fomo3D's timer, D17)... */
  addSeconds: number;
  /** ...but the clock never shows more than this. add = max = start is the old "reset to full" bomb. */
  maxSeconds: number;
};

export const DEFAULT_RULES: GameRules = { minBuyLamports: 100_000_000n, startSeconds: 1800, addSeconds: 120, maxSeconds: 1800 };

/** One trade on our coin, from the bonding curve or (after graduation) its PumpSwap pool. */
export type Trade = {
  sig: string;
  slot: number;
  /** Block time from pump's own event, unix seconds. The bomb runs on this, never on our clock (D4). */
  ts: number;
  wallet: string;
  side: "buy" | "sell";
  /** Buys: everything the buyer paid, pump's fees included, so a "0.1 SOL" button counts. Sells: SOL received. */
  lamports: bigint;
  tokens: bigint;
  /** The creator fee on this trade (what feeds the pot), when the event carries it. */
  creatorFee?: bigint;
};

/**
 * Turns decoded pump events from one transaction into trades on our coin.
 * Curve trades carry the mint; pool trades are ours when they hit our coin's canonical pool.
 */
export function tradesFrom(events: PumpEvent[], sig: string, slot: number, coin: { mint: string; pool: string }): Trade[] {
  const out: Trade[] = [];
  for (const e of events) {
    if (e.kind === "pumpTrade" && e.mint === coin.mint) {
      // The event's sol_amount is net of fees; a buyer pays sol_amount + fee + creator_fee.
      const fees = (e.fee ?? 0n) + (e.creatorFee ?? 0n);
      out.push({
        sig, slot, ts: e.timestamp, wallet: e.user, side: e.isBuy ? "buy" : "sell", lamports: e.isBuy ? e.solAmount + fees : e.solAmount,
        tokens: e.tokenAmount, ...(e.creatorFee !== null ? { creatorFee: e.creatorFee } : {}),
      });
    } else if ((e.kind === "ammBuy" || e.kind === "ammSell") && e.pool === coin.pool) {
      out.push({
        sig, slot, ts: e.timestamp, wallet: e.user, side: e.kind === "ammBuy" ? "buy" : "sell", lamports: e.userQuoteAmount, tokens: e.baseAmount,
        ...(e.creatorFee !== null ? { creatorFee: e.creatorFee } : {}),
      });
    }
  }
  return out;
}

export const qualifies = (t: Trade, rules: GameRules) => t.side === "buy" && t.lamports >= rules.minBuyLamports;

/**
 * On-chain order: slot, then position in the block. The stream doesn't give the position, so ties inside a
 * slot are broken by `rank` (the order getSignaturesForAddress returned, newest first) when we have it.
 * Returns oldest first.
 */
export function orderTrades<T extends Pick<Trade, "sig" | "slot">>(trades: T[], newestFirstSigs: string[] = []): T[] {
  const rank = new Map(newestFirstSigs.map((s, i) => [s, i]));
  return [...trades].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    const ra = rank.get(a.sig);
    const rb = rank.get(b.sig);
    if (ra !== undefined && rb !== undefined) return rb - ra; // larger rank = older
    return a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0; // stable fallback until the RPC settles it
  });
}

export type Round = {
  /** waiting: no qualifying buy yet, the bomb isn't lit. live: ticking. */
  status: "waiting" | "live";
  /** Qualifying buys this round, oldest first. */
  buys: Trade[];
};

export const emptyRound = (): Round => ({ status: "waiting", buys: [] });

/** When the bomb goes off: the first buy lights it, each later buy adds time up to the cap. Buys must be in on-chain order. */
export function deadline(r: Round, rules: GameRules): number | null {
  if (r.status !== "live" || r.buys.length === 0) return null;
  return deadlineOf(r.buys, rules);
}

function deadlineOf(buys: Pick<Trade, "ts">[], rules: GameRules): number | null {
  let d: number | null = null;
  for (const b of buys) d = d === null ? b.ts + rules.startSeconds : Math.min(d + rules.addSeconds, b.ts + rules.maxSeconds);
  return d;
}

export const leader = (r: Round): Trade | null => r.buys[r.buys.length - 1] ?? null;

export type BuyResult =
  | { kind: "ignored" } // too small, a sell, or already counted
  | { kind: "counted"; round: Round }
  /** The buy came after the bomb went off: the round is over and this buy lights the next one. */
  | { kind: "afterDeadline" };

/** Applies one trade to the round. Late-arriving buys that happened before the deadline still count. */
export function applyTrade(r: Round, t: Trade, rules: GameRules): BuyResult {
  if (!qualifies(t, rules)) return { kind: "ignored" };
  if (r.buys.some((b) => b.sig === t.sig && b.wallet === t.wallet && b.lamports === t.lamports)) return { kind: "ignored" };
  // Only the buys before this one decide whether the bomb was still lit when it landed. Adding time never
  // shortens the clock, so a late-arriving earlier buy can't knock out a later one that already counted.
  const buys = orderTrades([...r.buys, t]);
  const d = deadlineOf(buys.slice(0, buys.indexOf(t)), rules);
  if (d !== null && t.ts > d) return { kind: "afterDeadline" };
  return { kind: "counted", round: { status: "live", buys } };
}

/**
 * The bomb has gone off once our clock is past the deadline plus a grace period (late stream messages,
 * clock skew). The engine still confirms with the RPC before paying (D4).
 */
export function exploded(r: Round, rules: GameRules, nowSec: number, graceSec: number): boolean {
  const d = deadline(r, rules);
  return d !== null && nowSec > d + graceSec;
}

/**
 * Winner: the last qualifying buyer who still holds at least the tokens from that buy. If they sold, the win
 * walks back to the previous qualifying buy. null = nobody qualifies (the pot rolls into the next round).
 */
export async function pickWinner(
  r: Round,
  holds: (wallet: string) => Promise<bigint>,
  newestFirstSigs: string[] = [],
): Promise<{ buy: Trade; balance: bigint } | null> {
  const ordered = orderTrades(r.buys, newestFirstSigs);
  const checked = new Map<string, bigint>();
  for (let i = ordered.length - 1; i >= 0; i--) {
    const b = ordered[i]!;
    let bal = checked.get(b.wallet);
    if (bal === undefined) {
      bal = await holds(b.wallet);
      checked.set(b.wallet, bal);
    }
    if (bal >= b.tokens) return { buy: b, balance: bal };
  }
  return null;
}

/** What the winner gets: the pot minus the reserve, minus the share kept to seed the next round. */
export function payoutLamports(potBalance: bigint, reserve: bigint, rolloverBps: number): bigint {
  const available = potBalance - reserve;
  if (available <= 0n) return 0n;
  return (available * BigInt(10_000 - rolloverBps)) / 10_000n;
}
