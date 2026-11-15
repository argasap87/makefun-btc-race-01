# Bounce Rider — make.fun btc-race-24h-20261115-0828

A long-only momentum bot trading cbBTC/USDC on 1-minute bars
(`agent-fun/bars-replay/v1`, Node 22, `main.ts` at the repo root).

## Strategy

- **Entry:** EMA(8) crosses above EMA(16) **and** the 15-bar return is at
  least +60 bps. Full equity into the single position.
- **Exit (whole position, first reason that holds):** trailing stop 60 bps
  below the peak close since entry, EMA(8) crossing back below EMA(16),
  take profit +4% over cost, stop loss −2% under cost, or 480 bars held.
- **Risk:** one position, long only, no leverage; orders capped at 150 bps
  slippage past the close they were decided on.

## Dev window (local grade)

```
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Net PnL **+$39.10**, 2 trades (one round trip), max drawdown 0.52%.
Parameters are stable: moving any one of trail (50–80 bps), take-profit
(250–600 bps), stop (120–300 bps), momentum (50–70 bps), EMA spans
(6–10 / 14–18) or momentum window (15–20 bars) keeps the dev PnL positive.

## Layout

- `main.ts` — the bot (erasable TypeScript, standard library only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's SDK shim.
- `.makefun/owner.json` — the payout wallet claim file.
