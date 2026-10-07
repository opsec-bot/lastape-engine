import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES, applyTrade, deadline, emptyRound, exploded, leader, orderTrades, payoutLamports, pickWinner, qualifies, tradesFrom,
  type Round, type Trade,
} from "./game.js";
import type { PumpEvent } from "./pump/events.js";

const SOL = 1_000_000_000n;
// The old "every buy resets to 10 minutes" bomb, as a special case of the add-time rules.
const rules = { ...DEFAULT_RULES, startSeconds: 600, addSeconds: 600, maxSeconds: 600 };
let n = 0;
const buy = (ts: number, o: Partial<Trade> = {}): Trade => ({
  sig: `sig${++n}`, slot: ts, ts, wallet: `w${n}`, side: "buy", lamports: SOL / 10n, tokens: 1_000n, ...o,
});
const play = (trades: Trade[]): Round => {
  let r = emptyRound();
  for (const t of trades) {
    const res = applyTrade(r, t, rules);
    if (res.kind === "counted") r = res.round;
  }
  return r;
};

describe("qualifies", () => {
  it("needs a buy of at least 0.1 SOL", () => {
    expect(qualifies(buy(1), rules)).toBe(true);
    expect(qualifies(buy(1, { lamports: SOL / 10n - 1n }), rules)).toBe(false);
    expect(qualifies(buy(1, { side: "sell", lamports: SOL }), rules)).toBe(false);
  });
});

describe("the bomb", () => {
  it("isn't lit until the first qualifying buy", () => {
    const r = play([buy(100, { lamports: 1n })]);
    expect(r.status).toBe("waiting");
    expect(deadline(r, rules)).toBeNull();
    expect(exploded(r, rules, 1e12, 0)).toBe(false);
  });

  it("every qualifying buy resets it to the full 10 minutes and takes the lead", () => {
    const a = buy(1000);
    const b = buy(1300);
    const r = play([a, b]);
    expect(deadline(r, rules)).toBe(1900);
    expect(leader(r)?.sig).toBe(b.sig);
  });

  it("small buys don't touch the timer or the lead", () => {
    const a = buy(1000);
    const r = play([a, buy(1500, { lamports: SOL / 100n })]);
    expect(deadline(r, rules)).toBe(1600);
    expect(leader(r)?.sig).toBe(a.sig);
  });

  it("a buy after the deadline doesn't count; it belongs to the next round", () => {
    const r = play([buy(1000)]);
    expect(applyTrade(r, buy(1601), rules).kind).toBe("afterDeadline");
    expect(applyTrade(r, buy(1600), rules).kind).toBe("counted"); // exactly at the deadline still counts
  });

  it("a buy that arrives late but happened earlier is put in on-chain order", () => {
    const a = buy(1000);
    const c = buy(1200);
    const b = buy(1100);
    const r = play([a, c, b]);
    expect(r.buys.map((x) => x.sig)).toEqual([a.sig, b.sig, c.sig]);
    expect(leader(r)?.sig).toBe(c.sig);
    expect(deadline(r, rules)).toBe(1800);
  });

  it("goes off only after the deadline plus grace", () => {
    const r = play([buy(1000)]);
    expect(exploded(r, rules, 1605, 5)).toBe(false);
    expect(exploded(r, rules, 1606, 5)).toBe(true);
  });

  it("counts each buy once", () => {
    const a = buy(1000);
    const r = play([a]);
    expect(applyTrade(r, a, rules).kind).toBe("ignored");
  });
});

describe("orderTrades", () => {
  it("breaks ties in a slot by the RPC's newest-first order", () => {
    const x = buy(5, { sig: "zzz", slot: 7 });
    const y = buy(5, { sig: "aaa", slot: 7 });
    expect(orderTrades([x, y]).map((t) => t.sig)).toEqual(["aaa", "zzz"]); // fallback
    expect(orderTrades([x, y], ["aaa", "zzz"]).map((t) => t.sig)).toEqual(["zzz", "aaa"]); // aaa is newest
  });
});

describe("pickWinner", () => {
  it("is the last qualifying buyer who still holds", async () => {
    const a = buy(1000, { wallet: "alice" });
    const b = buy(1100, { wallet: "bob" });
    const r = play([a, b]);
    expect((await pickWinner(r, async () => 5_000n))?.buy.wallet).toBe("bob");
  });

  it("walks back when the last buyer sold", async () => {
    const r = play([buy(1000, { wallet: "alice" }), buy(1100, { wallet: "bob" })]);
    const w = await pickWinner(r, async (wallet) => (wallet === "bob" ? 10n : 5_000n));
    expect(w?.buy.wallet).toBe("alice");
  });

  it("is null when nobody still holds", async () => {
    const r = play([buy(1000), buy(1100)]);
    expect(await pickWinner(r, async () => 0n)).toBeNull();
  });

  it("checks each wallet's balance once", async () => {
    let calls = 0;
    const r = play([buy(1000, { wallet: "a" }), buy(1100, { wallet: "a" }), buy(1200, { wallet: "b" })]);
    await pickWinner(r, async () => {
      calls++;
      return 0n;
    });
    expect(calls).toBe(2);
  });
});

describe("payoutLamports", () => {
  it("keeps the reserve and the rollover share", () => {
    expect(payoutLamports(10n * SOL, 1_000_000n, 1000)).toBe(((10n * SOL - 1_000_000n) * 9n) / 10n);
    expect(payoutLamports(10n * SOL, 0n, 0)).toBe(10n * SOL);
    expect(payoutLamports(500n, 1_000n, 0)).toBe(0n);
  });
});

describe("tradesFrom", () => {
  const coin = { mint: "MINT", pool: "POOL" };
  it("keeps only our coin's curve and pool trades, buys counted with fees", () => {
    const events = [
      { kind: "pumpTrade", mint: "MINT", user: "u1", isBuy: true, solAmount: 5n, tokenAmount: 9n, timestamp: 10, fee: 1n, creatorFee: 2n },
      { kind: "pumpTrade", mint: "OTHER", user: "u2", isBuy: true, solAmount: 5n, tokenAmount: 9n, timestamp: 10 },
      { kind: "ammSell", pool: "POOL", user: "u3", timestamp: 11, baseAmount: 4n, userQuoteAmount: 3n },
      { kind: "ammBuy", pool: "ELSE", user: "u4", timestamp: 11, baseAmount: 4n, userQuoteAmount: 3n },
    ] as unknown as PumpEvent[];
    expect(tradesFrom(events, "s", 1, coin)).toEqual([
      { sig: "s", slot: 1, ts: 10, wallet: "u1", side: "buy", lamports: 8n, tokens: 9n, creatorFee: 2n }, // fees included
      { sig: "s", slot: 1, ts: 11, wallet: "u3", side: "sell", lamports: 3n, tokens: 4n },
    ]);
  });
});

describe("Fomo3D timer (D17)", () => {
  const fomo = { ...DEFAULT_RULES, startSeconds: 1800, addSeconds: 120, maxSeconds: 1800 };
  const run = (trades: Trade[]) => {
    let r = emptyRound();
    for (const t of trades) {
      const res = applyTrade(r, t, fomo);
      if (res.kind === "counted") r = res.round;
    }
    return r;
  };

  it("lights at the start time and caps added time", () => {
    expect(deadline(run([buy(1000)]), fomo)).toBe(2800);
    // At 1100 the clock shows 1700 s; +120 would be 1820 s, capped at 1800.
    expect(deadline(run([buy(1000), buy(1100)]), fomo)).toBe(2900);
    // At 2500 the clock shows 300 s; +120 = 420 s left.
    expect(deadline(run([buy(1000), buy(2500)]), fomo)).toBe(2920);
  });

  it("each buy adds on top of the last", () => {
    expect(deadline(run([buy(1000), buy(2700), buy(2800)]), fomo)).toBe(3040);
  });

  it("a late-arriving earlier buy adds its time where it happened", () => {
    const late = buy(2600);
    const r = run([buy(1000), buy(2900)]); // 2900 is past the 2800 deadline on its own
    expect(r.buys.length).toBe(1);
    const r2 = run([buy(1000), late]);
    expect(deadline(r2, fomo)).toBe(2920);
    // Now 2900 lands inside the extended clock.
    expect(applyTrade(r2, buy(2900), fomo).kind).toBe("counted");
  });

  it("start = add = max is the old reset bomb", () => {
    expect(deadline(play([buy(1000), buy(1300)]), rules)).toBe(1900);
  });
});
