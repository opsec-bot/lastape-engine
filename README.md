# lastape-engine

The rules behind **$BOMB** ([lastape.fly.dev](https://lastape.fly.dev)), in the open. This is the exact code the game
runs to decide every round: the bomb timer, the winner, the pot split, the round receipts, and a checker anyone can
run against the chain.

## The game
- Buy $BOMB for 0.1 SOL or more (anywhere: pump.fun, a DEX, a terminal) and you hold the detonator.
- The first buy lights a 30 minute bomb. Every later qualifying buy adds 2 minutes, never past 30 minutes.
- When it goes off, the last buyer still holding wins.

The pot is the coin's pump.fun creator fee (80% of it; the other 20% goes to the team). Each round splits what the
pot can hand out:

| Share | Who |
|---|---|
| 50% | The winner |
| 25% | Everyone who made a qualifying buy that round and still holds, by SOL bought |
| 10% | The referrers of that round's buyers, by their buyers' SOL |
| 15% | Rolls into the next round, plus every share nobody qualified for |

Winners are paid right away. Dividends and referrals are paid once a wallet is owed 0.1 SOL.

## What's in here
| File | What it does |
|---|---|
| `src/game.ts` | Turns pump.fun events into trades, the timer, on-chain ordering, picking the winner |
| `src/split.ts` | The pot split |
| `src/receipt.ts` | Round receipts: the canonical JSON, its hash, and `checkReceipt`, which re-runs a round from its receipt |
| `src/checker.ts` | `verifyRound`: checks a receipt against the chain |
| `src/pump/` | Decodes pump.fun and PumpSwap events from transaction logs |

## Check a round yourself
```
npm install
npm run verify-round -- 12
```
That checks round 12 on lastape.fly.dev with the free PublicNode RPC. Pass a site and an RPC URL to use others:
`npm run verify-round -- 12 https://lastape.fly.dev https://your-rpc`.

It checks three things:
1. **The rules.** The receipt's buys all qualify and landed before the bomb went off, the winner is the last buyer
   still holding, every referral is signed by the buyer's own wallet, and the split recomputes to the lamport.
2. **The memo.** The receipt's SHA-256 is in a memo transaction on Solana, written when the round closed, so the
   receipt can't be changed later.
3. **The chain.** The receipt's buys are exactly the coin's qualifying buys on-chain during the round. None
   added, none left out.

One thing it can't replay: token balances at the moment the round closed. The receipt records them, and the memo
locks them in.

## Referrals
A referral is a free signed message, not a transaction:

```
Last Ape Wins referral
My wallet: <wallet>
Referred by: <referrer>
Issued: <unix ms>
```

The site asks your wallet to sign it once. The first one counts and never changes, and it only counts for buys
made after it.

## Tests
```
npm test
```

## License
MIT
