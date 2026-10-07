import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  DISCRIMINATORS, POOL_ACCOUNT_DISCRIMINATOR, WSOL_MINT, decodeEvent, decodeLogs, decodePoolAccount, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID,
} from "./index.js";

// Two real base58 keys so encode/decode round-trips are meaningful.
const A = PUMP_PROGRAM_ID;
const B = PUMP_AMM_PROGRAM_ID;

class Writer {
  parts: Buffer[] = [];
  bytes(b: readonly number[]) { this.parts.push(Buffer.from(b)); return this; }
  pubkey(k: string) { this.parts.push(Buffer.from(bs58.decode(k))); return this; }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
  i64(v: number) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); this.parts.push(b); return this; }
  bool(v: boolean) { this.parts.push(Buffer.from([v ? 1 : 0])); return this; }
  string(s: string) { const d = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(d.length); this.parts.push(l, d); return this; }
  done() { return Buffer.concat(this.parts); }
}

function tradeEvent(extraTail = 0) {
  const w = new Writer()
    .bytes(DISCRIMINATORS.pumpTrade)
    .pubkey(A).u64(1_500_000_000n).u64(42_000_000n).bool(true).pubkey(B).i64(1_790_000_000)
    .u64(30n).u64(40n).u64(50n).u64(60n);
  if (extraTail) w.bytes(new Array(extraTail).fill(7));
  return w.done();
}

describe("decodeEvent", () => {
  it("decodes a pump TradeEvent", () => {
    expect(decodeEvent(tradeEvent())).toEqual({
      kind: "pumpTrade",
      mint: A,
      solAmount: 1_500_000_000n,
      tokenAmount: 42_000_000n,
      isBuy: true,
      user: B,
      timestamp: 1_790_000_000,
      virtualSolReserves: 30n,
      virtualTokenReserves: 40n,
      realSolReserves: 50n,
      realTokenReserves: 60n,
      fee: null,
      creatorFee: null,
    });
  });

  it("reads the protocol and creator fee when the event carries them", () => {
    const data = Buffer.concat([
      tradeEvent(),
      new Writer().pubkey(A).u64(95n).u64(1_000n).pubkey(B).u64(30n).u64(300n).done(),
    ]);
    expect(decodeEvent(data)).toMatchObject({ fee: 1_000n, creatorFee: 300n });
  });

  it("ignores fields pump appended after the prefix", () => {
    expect(decodeEvent(tradeEvent(300))?.kind).toBe("pumpTrade");
  });

  it("decodes a CreateEvent with its strings", () => {
    const data = new Writer()
      .bytes(DISCRIMINATORS.pumpCreate)
      .string("Cat Coin").string("CAT").string("https://x/y.json")
      .pubkey(A).pubkey(B).pubkey(A).pubkey(B).i64(1_790_000_001)
      .done();
    expect(decodeEvent(data)).toMatchObject({
      kind: "pumpCreate", name: "Cat Coin", symbol: "CAT", mint: A, creator: B, timestamp: 1_790_000_001,
    });
  });

  it("decodes PumpSwap buys from fixed offsets", () => {
    const w = new Writer().bytes(DISCRIMINATORS.ammBuy).i64(1_790_000_002).u64(1000n);
    // fields 2..13: put recognizable values in pool reserves (5, 6) and user quote amount (13)
    for (let i = 2; i <= 13; i++) w.u64(i === 5 ? 555n : i === 6 ? 666n : i === 13 ? 1313n : 0n);
    const data = w.pubkey(B).pubkey(A).done();
    expect(decodeEvent(data)).toEqual({
      kind: "ammBuy", pool: B, user: A, timestamp: 1_790_000_002,
      baseAmount: 1000n, poolBaseReserves: 555n, poolQuoteReserves: 666n, userQuoteAmount: 1313n, creatorFee: null,
    });
  });

  it("decodes a migration event into pool and mint", () => {
    const data = new Writer()
      .bytes(DISCRIMINATORS.pumpMigration)
      .pubkey(B).pubkey(A).u64(206_900_000_000_000n).u64(84_990_000_000n).u64(15_000_000n)
      .pubkey(B).i64(1_790_000_003).pubkey(WSOL_MINT)
      .done();
    expect(decodeEvent(data)).toEqual({
      kind: "pumpMigration", user: B, mint: A, mintAmount: 206_900_000_000_000n, solAmount: 84_990_000_000n,
      bondingCurve: B, timestamp: 1_790_000_003, pool: WSOL_MINT,
    });
  });

  it("returns null for unknown discriminators", () => {
    expect(decodeEvent(Buffer.alloc(40))).toBeNull();
  });

  it("throws on a truncated tracked event", () => {
    expect(() => decodeEvent(tradeEvent().subarray(0, 50))).toThrow(RangeError);
  });
});

describe("decodeLogs", () => {
  const data = (b: Buffer) => `Program data: ${b.toString("base64")}`;

  it("pulls events emitted by their own program and counts problems", () => {
    const logs = [
      `Program ${A} invoke [1]`,
      "Program log: Instruction: Buy",
      data(tradeEvent()),
      data(tradeEvent().subarray(0, 50)),
      data(Buffer.alloc(16)),
      `Program ${A} consumed 1000 of 200000 compute units`,
      `Program ${A} success`,
      "Log truncated",
    ];
    const out = decodeLogs(logs);
    expect(out.events).toHaveLength(1);
    expect(out.malformed).toBe(1);
    expect(out.truncated).toBe(true);
  });

  it("ignores a same-named event emitted by another program", () => {
    const other = "11111111111111111111111111111111";
    const logs = [
      `Program ${A} invoke [1]`,
      `Program ${other} invoke [2]`,
      data(tradeEvent()), // a fork's "TradeEvent": same discriminator, different program
      `Program ${other} success`,
      data(tradeEvent()), // back in pump: real
      `Program ${A} success`,
      data(tradeEvent()), // outside any program
    ];
    const out = decodeLogs(logs);
    expect(out.events).toHaveLength(1);
    expect(out.foreign).toBe(2);
  });
});

describe("decodePoolAccount", () => {
  it("reads base and quote mints at their fixed offsets", () => {
    const data = new Writer()
      .bytes(POOL_ACCOUNT_DISCRIMINATOR).bytes([255]).bytes([0, 0])
      .pubkey(B).pubkey(A).pubkey(WSOL_MINT).bytes(new Array(200).fill(0))
      .done();
    expect(decodePoolAccount(data)).toEqual({ baseMint: A, quoteMint: WSOL_MINT });
  });

  it("rejects other accounts", () => {
    expect(decodePoolAccount(Buffer.alloc(300))).toBeNull();
  });
});
