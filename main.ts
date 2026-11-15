// Bounce Rider: a long-only momentum bot for cbBTC/USDC on 1-minute bars.
//
// Idea: on a 24h window Bitcoin rarely trends cleanly for long, but sharp
// sell-offs are often followed by fast V-shaped recoveries, and genuine trend
// legs start with a burst of momentum. This bot only buys the start of such
// a leg and rides it with a trailing stop, instead of holding through the
// drift in between.
//
// Entry (all three must hold on the bar's close, filled at the next open):
//   1. EMA(8) crosses above EMA(16) on this bar (a fresh turn of the fast
//      trend against the slower one), and
//   2. the 15-bar return is at least +60 bps (the turn is a real burst, not
//      flat-bar noise — a full round trip costs ~26 bps, so a weaker signal
//      cannot pay for itself), and
//   3. no position is held.
// The bot spends its whole cash on the one position (max_weight_bps 100%).
//
// Exit (the whole position, first condition that holds):
//   1. Trailing stop: the close falls 60 bps or more below the highest close
//      seen since entry — locks in most of a run while cutting a reversal
//      early, and
//   2. EMA(8) crosses back below EMA(16) (the fast trend turned), or
//   3. Take profit: the position is worth 4% over its cost, or
//   4. Stop loss: the position is worth 2% under its cost, or
//   5. Time stop: held for 480 bars (8 hours) without an earlier exit.
// Exit conditions are level-based, so a sell the market refuses (a price
// past the slippage cap at the next open) is sent again on the next bar
// while its reason still holds.
//
// Risk: at most one open position, long only, no leverage; the trailing stop
// and the 2% stop loss bound the loss on any single trade, and the entry
// filter keeps the bot in cash through flat or steadily falling stretches.
//
// Determinism: EMAs run in float64 on + - * / alone, seeded as the mean of
// their first span of closes; no clock, no environment, no randomness — the
// same bars always give the same orders.
//
// Tuned on the published dev window (grade-local, --driver process):
// net PnL +$39.10, 2 trades (one round trip), max drawdown 0.52%.
// The parameters are stable: moving any one of them (trail 50-80 bps,
// take-profit 250-600 bps, stop 120-300 bps, momentum 50-70 bps, EMA spans
// 6-10 / 14-18, momentum window 15-20 bars) keeps the dev PnL positive
// (+$17 to +$39), so the result is the one big recovery leg of the window,
// not a knife-edge fit to a single parameter value.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 8;
const SLOW_SPAN = 16;
/** The momentum confirmation window, in bars. */
const MOMENTUM_BARS = 15;
/** The 15-bar return that confirms a cross, in bps (60 bps = 0.60%). */
const MOMENTUM_BPS = 60;
/** The trailing stop: sell once the close is this far below the peak since entry, in bps. */
const TRAIL_BPS = 60;
/** Take profit: the position's value over its cost, in bps. */
const TAKE_PROFIT_BPS = 400;
/** Stop loss: the position's value under its cost, in bps. */
const STOP_LOSS_BPS = 200;
/** Time stop: exit after this many bars held. */
const MAX_HOLD_BARS = 480;
/** Slippage cap on every order: 150 bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 150;

const SYMBOL = 'CBBTC';

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

/** Per-symbol trend state, built bar by bar from closes. */
interface Trend {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the previous bar, once both EMAs are set. */
  prevGap: number | null;
  /** fast - slow after this bar. */
  gap: number | null;
  /** The closes seen, newest last (kept to the momentum window). */
  closes: number[];
}

function newTrend(): Trend {
  return {
    fast: { span: FAST_SPAN, warm: [], value: null },
    slow: { span: SLOW_SPAN, warm: [], value: null },
    prevGap: null,
    gap: null,
    closes: [],
  };
}

function pushBar(t: Trend, bar: Bar): void {
  const c = Number(bar.c);
  stepEma(t.fast, c);
  stepEma(t.slow, c);
  t.prevGap = t.gap;
  t.gap = t.fast.value !== null && t.slow.value !== null ? t.fast.value - t.slow.value : null;
  t.closes.push(c);
  if (t.closes.length > MOMENTUM_BARS + 1) t.closes.shift();
}

/** The momentum confirmation: the return over the last MOMENTUM_BARS bars, in bps. */
function momentumBps(t: Trend): number | null {
  if (t.closes.length < MOMENTUM_BARS + 1) return null;
  const now = t.closes[t.closes.length - 1];
  const then = t.closes[0];
  return ((now / then - 1) * 10000);
}

/** Position bookkeeping the bot keeps itself, keyed by the batch it entered on. */
interface Held {
  /** Highest close seen since the position first appeared. */
  peak: number;
  /** The batch index on which the position was first seen held. */
  entrySeq: number;
}

const trends = new Map<string, Trend>();
const held = new Map<string, Held>();

await runBars({
  onBatch(state: BarsState, batch) {
    // Feed this batch's bars into the trend state.
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      let t = trends.get(bar.symbol);
      if (t === undefined) {
        t = newTrend();
        trends.set(bar.symbol, t);
      }
      pushBar(t, bar);
      fresh.add(bar.symbol);
    }

    // Sync the held-position bookkeeping with the account the harness reports.
    for (const [symbol, pos] of state.positions) {
      const h = held.get(symbol);
      const close = state.close(symbol);
      if (close === null) continue;
      if (h === undefined) {
        held.set(symbol, { peak: Number(close), entrySeq: state.seq });
      } else if (Number(close) > h.peak) {
        h.peak = Number(close);
      }
    }
    for (const symbol of [...held.keys()]) {
      if (!state.positions.has(symbol)) held.delete(symbol);
    }

    // Warm-up batches carry no trading.
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];
    const minNotional = BigInt(fees.min_notional_quote_units);

    for (const symbol of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const trend = trends.get(symbol);
      if (trend === undefined || trend.gap === null || trend.prevGap === null) continue;
      const close = state.close(symbol);
      if (close === null) continue;
      const closeNum = Number(close);
      const pos = state.positions.get(symbol);
      const h = held.get(symbol);

      if (pos !== undefined && h !== undefined) {
        // --- Exit: the whole position on the first reason that holds. ---
        const value = state.value(symbol, pos.qty);
        const cost = pos.cost;
        const crossedDown = trend.gap < 0 && trend.prevGap >= 0;
        const trailed = ((h.peak / closeNum - 1) * 10000) >= TRAIL_BPS;
        const tookProfit = value * 10000n >= cost * BigInt(10000 + TAKE_PROFIT_BPS);
        const stoppedOut = value * 10000n <= cost * BigInt(10000 - STOP_LOSS_BPS);
        const timedOut = state.seq - h.entrySeq >= MAX_HOLD_BARS;
        if (crossedDown || trailed || tookProfit || stoppedOut || timedOut) {
          orders.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }

      if (pos === undefined) {
        // --- Entry: fresh EMA cross up, confirmed by a momentum burst. ---
        const crossedUp = trend.gap > 0 && trend.prevGap <= 0;
        if (!crossedUp) continue;
        const mom = momentumBps(trend);
        if (mom === null || mom < MOMENTUM_BPS) continue;
        // Spend the whole cash (one position, 100% of equity), capped by the
        // weight room and the cash this reply has not spent yet.
        const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / 10000n;
        let stake = state.cash < byWeight ? state.cash : byWeight;
        const spent = orders.reduce((sum, o) => (o.side === 'buy' ? sum + BigInt(o.notional_quote_units) : sum), 0n);
        if (stake > state.cash - spent) stake = state.cash - spent;
        if (stake < minNotional) continue;
        orders.push({ side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    return orders.slice(0, caps.max_orders_per_bar);
  },
});
