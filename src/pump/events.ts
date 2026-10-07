// Decodes pump.fun and PumpSwap events from "Program data:" log lines.
//
// Only the fixed-size fields at the start of each event are read. pump appends new fields to
// the end of its events over time, so reading a prefix keeps working across program upgrades.

import bs58 from "bs58";
import { DISCRIMINATORS, POOL_ACCOUNT_DISCRIMINATOR, type EventKind } from "./programs.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "../config.js";

export type PumpTrade = {
  kind: "pumpTrade";
  mint: string;
  user: string;
  isBuy: boolean;
  solAmount: bigint;
  tokenAmount: bigint;
  timestamp: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  /** pump's protocol fee and the creator fee on this trade; null in events too short to carry them. */
  fee: bigint | null;
  creatorFee: bigint | null;
};

export type PumpCreate = {
  kind: "pumpCreate";
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  timestamp: number;
};

export type PumpComplete = {
  kind: "pumpComplete";
  user: string;
  mint: string;
  bondingCurve: string;
  timestamp: number;
};

/** A token graduating from the curve into its PumpSwap pool. Gives us pool -> mint for free. */
export type PumpMigration = {
  kind: "pumpMigration";
  user: string;
  mint: string;
  mintAmount: bigint;
  solAmount: bigint;
  bondingCurve: string;
  timestamp: number;
  pool: string;
};

export type AmmTrade = {
  kind: "ammBuy" | "ammSell";
  pool: string;
  user: string;
  timestamp: number;
  /** Base token bought (buy) or sold (sell). */
  baseAmount: bigint;
  /** Quote the user actually paid (buy) or received (sell), fees included. */
  userQuoteAmount: bigint;
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
  creatorFee: bigint | null;
};

export type PumpEvent = PumpTrade | PumpCreate | PumpComplete | PumpMigration | AmmTrade;

const LOG_PREFIX = "Program data: ";

class Reader {
  private offset: number;

  constructor(
    private readonly buf: Buffer,
    start: number,
  ) {
    this.offset = start;
  }

  at(offset: number): this {
    this.offset = offset;
    return this;
  }

  pubkey(): string {
    return bs58.encode(this.take(32));
  }

  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.need(8));
    this.offset += 8;
    return v;
  }

  i64(): number {
    const v = this.buf.readBigInt64LE(this.need(8));
    this.offset += 8;
    return Number(v);
  }

  bool(): boolean {
    const v = this.buf.readUInt8(this.need(1));
    this.offset += 1;
    return v !== 0;
  }

  string(): string {
    const len = this.buf.readUInt32LE(this.need(4));
    this.offset += 4;
    return this.take(len).toString("utf8");
  }

  private take(len: number): Buffer {
    const start = this.need(len);
    this.offset += len;
    return this.buf.subarray(start, start + len);
  }

  private need(len: number): number {
    if (this.offset + len > this.buf.length) throw new RangeError("event data too short");
    return this.offset;
  }
}

/** Reads trailing fields pump added later; older or shorter events fall back. */
function optional<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof RangeError) return fallback;
    throw e;
  }
}

function kindOf(data: Buffer): EventKind | null {
  if (data.length < 8) return null;
  for (const [kind, disc] of Object.entries(DISCRIMINATORS) as [EventKind, readonly number[]][]) {
    if (disc.every((b, i) => data[i] === b)) return kind;
  }
  return null;
}

/** Decode one event's raw bytes (discriminator first). Returns null for events we don't track. */
export function decodeEvent(data: Buffer): PumpEvent | null {
  const kind = kindOf(data);
  if (!kind) return null;
  const r = new Reader(data, 8);

  switch (kind) {
    case "pumpTrade":
      return {
        kind,
        mint: r.pubkey(),
        solAmount: r.u64(),
        tokenAmount: r.u64(),
        isBuy: r.bool(),
        user: r.pubkey(),
        timestamp: r.i64(),
        virtualSolReserves: r.u64(),
        virtualTokenReserves: r.u64(),
        realSolReserves: r.u64(),
        realTokenReserves: r.u64(),
        ...optional<{ fee: bigint | null; creatorFee: bigint | null }>(() => {
          r.pubkey(); // fee_recipient
          r.u64(); // fee_basis_points
          const fee = r.u64();
          r.pubkey(); // creator
          r.u64(); // creator_fee_basis_points
          return { fee, creatorFee: r.u64() };
        }, { fee: null, creatorFee: null }),
      };
    case "pumpCreate":
      return {
        kind,
        name: r.string(),
        symbol: r.string(),
        uri: r.string(),
        mint: r.pubkey(),
        bondingCurve: r.pubkey(),
        user: r.pubkey(),
        creator: r.pubkey(),
        timestamp: r.i64(),
      };
    case "pumpComplete":
      return { kind, user: r.pubkey(), mint: r.pubkey(), bondingCurve: r.pubkey(), timestamp: r.i64() };
    case "pumpMigration": {
      const user = r.pubkey();
      const mint = r.pubkey();
      const mintAmount = r.u64();
      const solAmount = r.u64();
      r.u64(); // pool_migration_fee
      return { kind, user, mint, mintAmount, solAmount, bondingCurve: r.pubkey(), timestamp: r.i64(), pool: r.pubkey() };
    }
    case "ammBuy":
    case "ammSell": {
      // Both events share this layout for the fields we read: 14 u64/i64 fields, then pool and user.
      const timestamp = r.i64();
      const baseAmount = r.u64();
      const poolBaseReserves = r.at(48).u64();
      const poolQuoteReserves = r.u64();
      const userQuoteAmount = r.at(112).u64();
      const pool = r.pubkey();
      const user = r.pubkey();
      // Then 5 more pubkeys (token accounts, fee recipient, coin creator) and the coin creator's fee.
      const creatorFee = optional<bigint | null>(() => r.at(352).u64(), null);
      return { kind, pool, user, timestamp, baseAmount, userQuoteAmount, poolBaseReserves, poolQuoteReserves, creatorFee };
    }
  }
}

/**
 * Read base and quote mints from a PumpSwap `Pool` account's data.
 * Layout: discriminator(8) pool_bump u8, index u16, creator(32), base_mint(32), quote_mint(32), ...
 */
export function decodePoolAccount(data: Buffer): { baseMint: string; quoteMint: string } | null {
  if (data.length < 107 || !POOL_ACCOUNT_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const r = new Reader(data, 43);
  return { baseMint: r.pubkey(), quoteMint: r.pubkey() };
}

// Anchor event discriminators are a hash of the event NAME, so any program that emits an event called
// "TradeEvent" collides with pump's. Each kind is only accepted from the program that owns it.
const OWNER: Record<EventKind, string> = {
  pumpTrade: PUMP_PROGRAM_ID,
  pumpCreate: PUMP_PROGRAM_ID,
  pumpComplete: PUMP_PROGRAM_ID,
  pumpMigration: PUMP_PROGRAM_ID,
  ammBuy: PUMP_AMM_PROGRAM_ID,
  ammSell: PUMP_AMM_PROGRAM_ID,
};

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;

/**
 * Decode every tracked event in a transaction's log messages, following the invoke stack so each
 * "Program data:" line is attributed to the program that emitted it. Malformed events are counted, not thrown.
 */
export function decodeLogs(logs: readonly string[]): { events: PumpEvent[]; malformed: number; foreign: number; truncated: boolean } {
  const events: PumpEvent[] = [];
  const stack: string[] = [];
  let malformed = 0;
  let foreign = 0;
  let truncated = false;

  for (const line of logs) {
    if (line === "Log truncated") {
      truncated = true;
      continue;
    }
    const invoke = INVOKE.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith(LOG_PREFIX)) continue;

    const data = Buffer.from(line.slice(LOG_PREFIX.length), "base64");
    const kind = kindOf(data);
    if (!kind) continue;
    if (stack[stack.length - 1] !== OWNER[kind]) {
      foreign++;
      continue;
    }
    try {
      const event = decodeEvent(data);
      if (event) events.push(event);
    } catch {
      malformed++;
    }
  }

  return { events, malformed, foreign, truncated };
}
