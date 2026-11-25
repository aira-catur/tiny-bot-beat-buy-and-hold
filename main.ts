// Tiny Bot: oversold-dip buyer with fast, measured exits.
//
// Idea: buy-and-hold owns every symbol all the time, so it eats every leg of
// every decline at full weight. Hourly crypto bars over-react: a symbol that
// has fallen sharply in half a day with an oversold RSI snaps back more often
// than it keeps falling. This bot waits in USDC, buys only those sharp dips
// (never a symbol in day-long free fall), and leaves quickly: a small
// take-profit, an RSI recovery, a hard stop, or a time limit, whichever comes
// first. Exposure stays low, so fees and drawdowns stay small, while a rising
// window still offers hourly dips to buy all the way up.
//
// Rules (all decided on a bar's close, filled at the next bar's open):
//   - Indicators per symbol over its own closes: Wilder RSI(14), trailing
//     returns over MOM_SHORT / MOM_LONG bars, plus EMA(FAST)/EMA(SLOW)/EMA(TREND)
//     kept for context in the series state.
//   - Entry (symbol not held): trailing MOM_SHORT return at or under DIP_RET
//     and RSI under DIP_RSI, with the MOM_LONG return no worse than -12%.
//     Candidates are ranked by dip depth and oversold-ness; at most
//     MAX_POSITIONS are held at once.
//   - Position size: the smallest of caps.max_weight_bps of equity (via
//     state.weightRoom), a quarter of equity, and an even share of the cash
//     left for the remaining free slots. Orders below fees.min_notional are
//     skipped, and nothing is sent while state.warmingUp is true.
//   - Exit (whole position, re-checked every bar): take-profit at
//     TAKE_PROFIT over cost, RSI recovered past RECOVER_RSI, a hard stop at
//     STOP_LOSS under cost, a trailing give-back after a strong run, or
//     MAX_HOLD_BARS bars without a bounce. Exits are re-sent while their
//     reason still holds, so a refused sell is retried on the next bar.
//   - Deterministic: float64 arithmetic only, no clock, no randomness.

import { BPS, runBars, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST = 8;
const SLOW = 21;
const TREND = 36;
const MOM_SHORT = 12;
const MOM_LONG = 24;
const RSI_BARS = 14;
const MAX_POSITIONS = 3;
const DIP_RET = -0.02; // a dip: trailing 12-bar return at or under -2%
const DIP_RSI = 38; // ...with RSI under this (oversold, not just drifting)
const RECOVER_RSI = 62; // exit once RSI has recovered past this
const STOP_LOSS = 0.06; // sell at 6% under cost: a dip that keeps falling is wrong
const TAKE_PROFIT = 0.045; // sell at 4.5% over cost: snap-backs are quick, bank them
const MAX_HOLD_BARS = 36; // a dip that has not bounced in 36 bars is exited
const TRAIL_ARM = 0.08; // trailing stop arms at +8%
const TRAIL_GIVE = 0.05; // ...and fires after a 5% give-back from the peak
const SLIPPAGE_BPS = 200;

interface Series {
  closes: number[];
  fast: number | null;
  slow: number | null;
  trend: number | null;
  fastSeed: number[];
  slowSeed: number[];
  trendSeed: number[];
  /** Wilder RSI state: seed changes, then the smoothed gain/loss averages. */
  rsiSeed: number[];
  gain: number | null;
  loss: number | null;
  lastClose: number | null;
}

const series = new Map<string, Series>();
/** Best close-relative value seen for a held symbol, as value/cost ratio. */
const peakRatio = new Map<string, number>();
/** Batch seq at which each currently held symbol was first seen held. */
const entrySeq = new Map<string, number>();

function rsiOf(s: Series): number | null {
  if (s.gain === null || s.loss === null) return null;
  const moved = s.gain + s.loss;
  return moved === 0 ? 50 : (100 * s.gain) / moved;
}

function emaStep(value: number | null, seed: number[], span: number, close: number): { value: number | null; seed: number[] } {
  if (value !== null) return { value: value + (2 / (span + 1)) * (close - value), seed };
  seed.push(close);
  if (seed.length === span) return { value: seed.reduce((a, x) => a + x, 0) / span, seed: [] };
  return { value: null, seed };
}

function push(symbol: string, close: number): Series {
  let s = series.get(symbol);
  if (s === undefined) {
    s = { closes: [], fast: null, slow: null, trend: null, fastSeed: [], slowSeed: [], trendSeed: [], rsiSeed: [], gain: null, loss: null, lastClose: null };
    series.set(symbol, s);
  }
  if (s.lastClose !== null) {
    const change = close - s.lastClose;
    if (s.gain === null || s.loss === null) {
      s.rsiSeed.push(change);
      if (s.rsiSeed.length === RSI_BARS) {
        s.gain = s.rsiSeed.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_BARS;
        s.loss = s.rsiSeed.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_BARS;
      }
    } else {
      s.gain = (s.gain * (RSI_BARS - 1) + (change > 0 ? change : 0)) / RSI_BARS;
      s.loss = (s.loss * (RSI_BARS - 1) + (change < 0 ? -change : 0)) / RSI_BARS;
    }
  }
  s.lastClose = close;
  s.closes.push(close);
  const f = emaStep(s.fast, s.fastSeed, FAST, close); s.fast = f.value; s.fastSeed = f.seed;
  const sl = emaStep(s.slow, s.slowSeed, SLOW, close); s.slow = sl.value; s.slowSeed = sl.seed;
  const tr = emaStep(s.trend, s.trendSeed, TREND, close); s.trend = tr.value; s.trendSeed = tr.seed;
  return s;
}

function ret(s: Series, bars: number): number | null {
  const n = s.closes.length;
  if (n <= bars) return null;
  const then = s.closes[n - 1 - bars]!;
  return then === 0 ? null : s.closes[n - 1]! / then - 1;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(bar.symbol, Number(bar.c));
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const orders: OrderInput[] = [];

    // ---- exits first ------------------------------------------------------
    const sells: SellInput[] = [];
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held === undefined) { peakRatio.delete(symbol); entrySeq.delete(symbol); continue; }
      if (!entrySeq.has(symbol)) entrySeq.set(symbol, state.seq);
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const value = state.value(symbol, held.qty);
      const ratio = held.cost > 0n ? Number(value) / Number(held.cost) : 1;
      const peak = Math.max(peakRatio.get(symbol) ?? ratio, ratio);
      peakRatio.set(symbol, peak);
      const rsiNow = rsiOf(s);
      const recovered = rsiNow !== null && rsiNow >= RECOVER_RSI;
      const stale = state.seq - (entrySeq.get(symbol) ?? state.seq) >= MAX_HOLD_BARS;
      const stop = ratio <= 1 - STOP_LOSS;
      const take = ratio >= 1 + TAKE_PROFIT;
      const trail = peak >= 1 + TRAIL_ARM && ratio <= peak - TRAIL_GIVE;
      if (stop || take || trail || recovered || stale) {
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: SLIPPAGE_BPS });
      }
    }
    for (const sell of sells) {
      if (orders.length >= caps.max_orders_per_bar) break;
      orders.push(sell);
    }

    // ---- entries ----------------------------------------------------------
    const heldCount = state.positions.size;
    let freeSlots = Math.min(MAX_POSITIONS, caps.max_open_positions) - heldCount;
    if (freeSlots > 0) {
      const scored: { symbol: string; score: number }[] = [];
      for (const { symbol } of state.hello.symbols) {
        if (state.positions.has(symbol) || !fresh.has(symbol)) continue;
        if (sells.some((x) => x.symbol === symbol)) continue;
        const s = series.get(symbol)!;
        const mShort = ret(s, MOM_SHORT);
        const mLong = ret(s, MOM_LONG);
        const rsiNow = rsiOf(s);
        if (mShort === null || mLong === null || rsiNow === null) continue;
        // The dip entry: a sharp short fall with oversold RSI. The deeper the
        // dip (down to a point), the higher it ranks; a symbol in free fall
        // for a full day (very negative long return) is left alone.
        if (mShort > DIP_RET) continue;
        if (rsiNow >= DIP_RSI) continue;
        if (mLong < -0.12) continue;
        scored.push({ symbol, score: -mShort + (DIP_RSI - rsiNow) / 200 });
      }
      scored.sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1));
      let cash = state.cash;
      for (const cand of scored) {
        if (freeSlots <= 0 || orders.length >= caps.max_orders_per_bar) break;
        const byWeight = state.weightRoom(cand.symbol);
        const quarter = state.equity / 4n;
        const share = cash / BigInt(freeSlots);
        let slice = byWeight < quarter ? byWeight : quarter;
        if (share < slice) slice = share;
        if (slice < minNotional || slice === 0n) continue;
        const buy: BuyInput = { side: 'buy', symbol: cand.symbol, notional_quote_units: slice, max_slippage_bps: SLIPPAGE_BPS };
        orders.push(buy);
        cash -= slice;
        freeSlots--;
      }
    }

    void BPS;
    return orders;
  },
});
