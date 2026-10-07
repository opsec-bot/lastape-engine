// Program ids and event discriminators, taken from the IDLs in @pump-fun/pump-sdk 2.0.0
// (src/idl/pump.json, src/idl/pump_amm.json).

export { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "../config.js";

export const DISCRIMINATORS = {
  pumpTrade: [189, 219, 127, 211, 78, 230, 97, 238],
  pumpCreate: [27, 114, 169, 77, 222, 235, 99, 118],
  pumpComplete: [95, 114, 97, 156, 212, 46, 152, 8],
  pumpMigration: [189, 233, 93, 185, 92, 148, 234, 148],
  ammBuy: [103, 244, 82, 31, 44, 245, 119, 119],
  ammSell: [62, 47, 55, 10, 165, 3, 220, 42],
} as const;

export type EventKind = keyof typeof DISCRIMINATORS;

/** PumpSwap `Pool` account discriminator. */
export const POOL_ACCOUNT_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188] as const;

/** Wrapped SOL, the quote mint of almost every PumpSwap pool. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** pump.fun tokens use 6 decimals; SOL uses 9. */
export const PUMP_TOKEN_DECIMALS = 6;
export const SOL_DECIMALS = 9;
