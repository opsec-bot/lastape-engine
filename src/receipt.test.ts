import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { canonicalJson, checkReceipt, receiptHash, referralMessage, verifyWalletSignature, type Receipt } from "./receipt.js";
import { DEFAULT_SPLIT_BPS, splitPot } from "./split.js";

/** A real ed25519 wallet: base58 address and a signer. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  return { address: bs58.encode(Buffer.from(x, "base64url")), sign: (m: string) => bs58.encode(sign(null, Buffer.from(m), privateKey)) };
}

const SOL = 1_000_000_000n;

function receipt(): Receipt {
  const alice = wallet(), bob = wallet(), ref = wallet();
  const message = referralMessage(alice.address, ref.address, 1_000_000);
  const referrals = [{ wallet: alice.address, referrer: ref.address, boundAt: 50, message, signature: alice.sign(message) }];
  const buys = [
    { sig: "s1", slot: 1, ts: 100, wallet: alice.address, lamports: String(SOL), tokens: "1000" },
    { sig: "s2", slot: 2, ts: 200, wallet: bob.address, lamports: String(3n * SOL), tokens: "1000" },
  ];
  const balances = { [alice.address]: "1000", [bob.address]: "1000" };
  const res = splitPot({
    available: 10n * SOL, winner: bob.address, bps: DEFAULT_SPLIT_BPS,
    buys: buys.map((b) => ({ ...b, lamports: BigInt(b.lamports), tokens: BigInt(b.tokens) })),
    balances: new Map(Object.entries(balances).map(([k, v]) => [k, BigInt(v)])),
    referrerOf: (w) => (w === alice.address ? ref.address : null),
  });
  return {
    v: 1, game: "BOMB", mint: "MINT", pool: "POOL", round: 1, rules: { minBuyLamports: String(SOL / 10n), startSeconds: 1800, addSeconds: 120, maxSeconds: 1800 },
    split: DEFAULT_SPLIT_BPS, teamWallets: [], available: String(10n * SOL), buys, balances, referrals, winner: bob.address,
    shares: res.shares.map((s) => ({ ...s, lamports: s.lamports.toString() })), rollover: res.rollover.toString(),
  };
}

describe("receipts", () => {
  it("an honest receipt checks out", () => {
    expect(checkReceipt(receipt())).toEqual([]);
  });

  it("catches a changed winner, a forged referral, a padded share and a late buy", () => {
    const r = receipt();
    expect(checkReceipt({ ...r, winner: r.buys[0]!.wallet })[0]).toMatch(/^winner should be/);
    // Someone swaps in their own address as referrer and rebuilds the text, but can't re-sign as alice.
    const thief = wallet().address;
    const forged = { ...r, referrals: [{ ...r.referrals[0]!, referrer: thief, message: referralMessage(r.buys[0]!.wallet, thief, 1_000_000) }] };
    expect(checkReceipt(forged)).toContain(`referral for ${r.buys[0]!.wallet}: bad signature`);
    const padded = { ...r, shares: r.shares.map((s) => (s.kind === "win" ? { ...s, lamports: String(BigInt(s.lamports) + 1n) } : s)) };
    expect(checkReceipt(padded).some((p) => p.startsWith("unexpected share win:"))).toBe(true);
    const late = { ...r, buys: [...r.buys, { ...r.buys[1]!, sig: "s3", slot: 9, ts: 99_999 }] };
    expect(checkReceipt(late)).toContain("buy s3 came after the bomb went off");
  });

  it("hashes the same whatever the key order", () => {
    const r = receipt();
    const shuffled = JSON.parse(canonicalJson(r)) as Receipt;
    expect(receiptHash(shuffled)).toBe(receiptHash(r));
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  it("verifies wallet signatures", () => {
    const w = wallet();
    expect(verifyWalletSignature(w.address, "hi", w.sign("hi"))).toBe(true);
    expect(verifyWalletSignature(w.address, "hi", w.sign("ho"))).toBe(false);
  });
});
