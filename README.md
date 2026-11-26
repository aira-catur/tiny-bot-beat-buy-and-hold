# Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana

Entry note: the final locked strategy is an oversold dip-buyer (12-bar return ≤ −2%, RSI(14) < 38), verified at +86.73 USDC net on the kit's dev replay versus −869.34 for buy-and-hold, with all guardrails met.

[![Competition](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/aira-catur/tiny-bot-beat-buy-and-hold/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/aira-catur/tiny-bot-beat-buy-and-hold/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Entry for [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1): a tiny paper-trading bot (`main.ts`, TypeScript, `agent-fun/bars-replay/v1`) that replays hourly Solana bars and decides when to hold an asset and when to sit in USDC.

## Strategy: buy the oversold dip, leave early

Buy-and-hold owns every symbol all the time, so it eats every leg of every decline at full weight. Hourly crypto bars over-react: a symbol that has fallen sharply over half a day with an oversold RSI snaps back more often than it keeps falling. This bot waits in USDC and only buys those dips:

- **Indicators** per symbol over its own closes: Wilder RSI(14) and trailing returns over 12 and 24 bars.
- **Entry** (symbol not held): trailing 12-bar return at or under −2% and RSI under 38, with the 24-bar return no worse than −12% (no day-long free fall). Candidates are ranked by dip depth and oversold-ness; at most 3 positions at once.
- **Sizing** respects the harness: the smallest of `caps.max_weight_bps` of equity (via `state.weightRoom`), a quarter of equity, and an even share of the remaining cash per free slot; orders below `fees.min_notional_quote_units` are skipped and nothing is sent while `state.warmingUp` is true.
- **Exits** (whole position, re-checked every bar, re-sent while the reason holds): take-profit at +4.5% over cost, RSI recovered past 62, a hard stop at −6% under cost, a trailing give-back after a strong run, or 36 bars without a bounce.
- Deterministic: float64 arithmetic only, no clock, no randomness — the two grading executions agree byte for byte.

## Measured dev scores (kit grade-local, dev window)

| Bot | Net PnL (USDC) | Trades | Max drawdown |
| --- | ---: | ---: | ---: |
| **This bot** | **+86.733505** | 14 | 0.0413 |
| macd-cci (best house baseline) | −20.219722 | 17 | 0.0246 |
| rsi-bollinger | −56.488060 | 8 | 0.0516 |
| ema-cross | −173.035531 | 28 | 0.0251 |
| momentum | −268.226895 | 19 | 0.0566 |
| buy-and-hold | −869.338396 | 7 | 0.1092 |

On the dev window this bot finishes positive (+0.87% return, 75% win rate) while buy-and-hold loses −8.69% — a margin of about +956 USDC over buy-and-hold — and it stays inside every guardrail (≥8 trades, max drawdown ≤25%). The final score comes from the house's final window after the deadline; past dev performance does not guarantee the same result there.
