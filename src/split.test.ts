import { describe, expect, it } from "vitest";
import { DEFAULT_SPLIT_BPS, assertSplit, drawAirdrop, splitPot, type SplitInput } from "./split.js";

const SOL = 1_000_000_000n;
const b = (wallet: string, sol: number, ts = 100, tokens = 1_000n) => ({ wallet, lamports: (SOL * BigInt(sol * 10)) / 10n, tokens, ts });
const base = (o: Partial<SplitInput>): SplitInput => ({
  available: 10n * SOL, buys: [], winner: null, balances: new Map(), referrerOf: () => null, bps: DEFAULT_SPLIT_BPS, ...o,
});
const get = (r: ReturnType<typeof splitPot>, kind: string, wallet: string) => r.shares.find((s) => s.kind === kind && s.wallet === wallet)?.lamports ?? 0n;
// Everything this round hands out, keeps, or adds to the airdrop pot adds back up to `available` (drops come from the airdrop pot).
const total = (r: ReturnType<typeof splitPot>) => r.shares.filter((s) => s.kind !== "drop").reduce((a, s) => a + s.lamports, 0n) + r.rollover + r.airdropIn;

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
    expect(r.rollover).toBe(SOL * 13n / 10n);
    expect(r.airdropIn).toBe(SOL / 5n);
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
    expect(r.rollover).toBe(10n * SOL - SOL / 5n);
    expect(r.airdropIn).toBe(SOL / 5n);
  });

  it("nothing to split", () => {
    expect(splitPot(base({ available: -5n }))).toEqual({ shares: [], rollover: 0n, airdropIn: 0n, airdropPool: 0n, draw: null });
  });

  it("rejects a split that doesn't total 100%", () => {
    expect(() => assertSplit({ winnerBps: 5000, dividendBps: 2500, referralBps: 1000, rolloverBps: 1500, airdropBps: 200 })).toThrow();
  });
});

describe("airdrop (D19)", () => {
  // Find block hashes that hit and miss, so the tests don't depend on luck.
  const find = (hit: boolean, round = 1) => {
    for (let i = 0; ; i++) if (drawAirdrop(round, `hash${i}`, 3, 1000).hit === hit) return `hash${i}`;
  };
  const buys = [b("a", 1, 100), b("b", 1, 110), b("c", 2, 120)];
  const held = new Map([["a", 1_000n], ["b", 1_000n], ["c", 1_000n]]);

  it("a miss adds this round's 2% to the airdrop pot", () => {
    const r = splitPot(base({ buys, winner: "c", balances: held, airdrop: { round: 1, pool: 3n * SOL, chanceBps: 1000, blockhash: find(false) } }));
    expect(r.draw).toMatchObject({ hit: false, tickets: 3, winner: null });
    expect(r.airdropIn).toBe(SOL / 5n);
    expect(r.airdropPool).toBe(3n * SOL + SOL / 5n);
    expect(r.shares.some((s) => s.kind === "drop")).toBe(false);
    expect(total(r)).toBe(10n * SOL);
  });

  it("a hit hands the whole airdrop pot to one ticket", () => {
    const hash = find(true);
    const r = splitPot(base({ buys, winner: "c", balances: held, airdrop: { round: 1, pool: 3n * SOL, chanceBps: 1000, blockhash: hash } }));
    const winner = buys[drawAirdrop(1, hash, 3, 1000).ticket!]!.wallet;
    expect(r.draw).toMatchObject({ hit: true, tickets: 3, winner });
    expect(r.shares.find((s) => s.kind === "drop")).toEqual({ wallet: winner, kind: "drop", lamports: 3n * SOL + SOL / 5n });
    expect(r.airdropPool).toBe(0n);
    expect(total(r)).toBe(10n * SOL);
  });

  it("sellers have no tickets; with no tickets a hit pays nobody and the pot stays", () => {
    const hash = find(true);
    const r = splitPot(base({ buys, winner: null, balances: new Map(), airdrop: { round: 1, pool: SOL, chanceBps: 1000, blockhash: hash } }));
    expect(r.draw).toMatchObject({ hit: true, tickets: 0, ticket: null, winner: null });
    expect(r.airdropPool).toBe(SOL + SOL / 5n);
  });

  it("the draw is the same for anyone who recomputes it", () => {
    expect(drawAirdrop(7, "SomeBlockHash", 10, 1000)).toEqual(drawAirdrop(7, "SomeBlockHash", 10, 1000));
    expect(drawAirdrop(7, "SomeBlockHash", 10, 1000)).not.toEqual(drawAirdrop(8, "SomeBlockHash", 10, 1000));
  });
});
