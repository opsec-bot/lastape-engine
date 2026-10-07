import { describe, expect, it } from "vitest";
import { DEFAULT_SPLIT_BPS, assertSplit, splitPot, type SplitInput } from "./split.js";

const SOL = 1_000_000_000n;
const b = (wallet: string, sol: number, ts = 100, tokens = 1_000n) => ({ wallet, lamports: (SOL * BigInt(sol * 10)) / 10n, tokens, ts });
const base = (o: Partial<SplitInput>): SplitInput => ({
  available: 10n * SOL, buys: [], winner: null, balances: new Map(), referrerOf: () => null, bps: DEFAULT_SPLIT_BPS, ...o,
});
const get = (r: ReturnType<typeof splitPot>, kind: string, wallet: string) => r.shares.find((s) => s.kind === kind && s.wallet === wallet)?.lamports ?? 0n;
const total = (r: ReturnType<typeof splitPot>) => r.shares.reduce((a, s) => a + s.lamports, 0n) + r.rollover;

describe("splitPot", () => {
  it("50 / 25 / 10 / 15 with everyone holding and referred", () => {
    const r = splitPot(base({
      buys: [b("a", 1), b("b", 3)], winner: "b",
      balances: new Map([["a", 1_000n], ["b", 1_000n]]),
      referrerOf: (w) => (w === "a" ? "ref1" : "ref2"),
    }));
    expect(get(r, "win", "b")).toBe(5n * SOL);
    expect(get(r, "div", "a")).toBe(SOL * 25n / 40n); // 2.5 SOL pool, a has 1 of 4 keys
    expect(get(r, "div", "b")).toBe(SOL * 75n / 40n);
    expect(get(r, "ref", "ref1")).toBe(SOL / 4n); // 1 SOL pool, a's 1 of 4 keys
    expect(get(r, "ref", "ref2")).toBe(SOL * 3n / 4n);
    expect(r.rollover).toBe(SOL * 3n / 2n);
    expect(total(r)).toBe(10n * SOL);
  });

  it("sellers lose their dividend and it rolls over", () => {
    const r = splitPot(base({ buys: [b("a", 1), b("b", 1)], winner: "b", balances: new Map([["a", 999n], ["b", 1_000n]]) }));
    expect(get(r, "div", "a")).toBe(0n);
    expect(get(r, "div", "b")).toBe(SOL * 5n / 4n);
    expect(total(r)).toBe(10n * SOL);
  });

  it("a wallet must hold everything it bought this round", () => {
    const r = splitPot(base({ buys: [b("a", 1, 100, 600n), b("a", 1, 110, 600n)], balances: new Map([["a", 1_000n]]) }));
    expect(get(r, "div", "a")).toBe(0n);
  });

  it("referral counts only for buys after the referrer was bound, and never self", () => {
    const r = splitPot(base({
      buys: [b("a", 1, 100), b("a", 1, 200), b("c", 2, 200)],
      referrerOf: (w, ts) => (w === "a" && ts >= 150 ? "ref" : w === "c" ? "c" : null),
    }));
    expect(get(r, "ref", "ref")).toBe(SOL / 4n); // 1 of 4 keys
    expect(get(r, "ref", "c")).toBe(0n);
    expect(total(r)).toBe(10n * SOL);
  });

  it("no winner and no buys: everything rolls over", () => {
    const r = splitPot(base({}));
    expect(r.shares).toEqual([]);
    expect(r.rollover).toBe(10n * SOL);
  });

  it("nothing to split", () => {
    expect(splitPot(base({ available: -5n }))).toEqual({ shares: [], rollover: 0n });
  });

  it("rejects a split that doesn't total 100%", () => {
    expect(() => assertSplit({ winnerBps: 5000, dividendBps: 2500, referralBps: 1000, rolloverBps: 1000 })).toThrow();
  });
});
