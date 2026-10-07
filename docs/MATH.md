# Budget policy and evaluation mathematics

The application separates deterministic policy construction (Agent 1) from constrained selection (Agent 2). These are inspectable algorithms, not paid model calls. The four cloud profiles—Atlas Pro, Nova Balanced, Spark Mini, and Swift Lite—are fictional teaching data. Their prices, per-task quality, and latency are illustrative. None is a claim about a vendor or a measured experiment.

## Calendar, spend, and projection

Let `B` be the configured monthly budget, `S` settled spend including the opening balance, and `H` current reservations. Remaining team funds are `R = max(B − S − H, 0)`. Utilization is `S / B`; reservations are shown separately. The backend supplies `S` with opening spend already included, so the engine never adds that opening balance again.

Let `D` be the actual number of days in the UTC calendar month and `e` the elapsed fractional days. A date with no time is interpreted at noon UTC. February and December-to-January boundaries follow the Gregorian calendar. Spend projection is:

```
projectedSpend = S + S / max(e, 1) × (D − e)
```

At a cold start (`S = 0` and no completed requests), a zero projection would be misleading. Instead, projection equals configured monthly request volume times the mean estimated cost of the profiles in the chosen execution mode. This seeded estimate uses the current prompt and output allowance and is explicitly labeled as an assumption. It is not a forecast trained on observed traffic.

Configured remaining request volume is `Nc = monthlyRequests × (D − e) / D`. With fewer than 20 observed completions, `N = Nc`. At 20 or more, `N = max(Nc, completedRequests / max(e, 1) × (D − e))`. The configured forecast remains a lower bound because opening spend may represent past requests that this prototype has not observed. This prevents an abrupt increase in allowance at the 20th completion and lets unusually high observed traffic tighten allowances.

## Pressure, importance, and allowances

With `clip(x) = min(max(x, 0), 1)`, budget pressure is:

```
p = max(clip(projectedSpend / B − 1), clip(1 − R / (0.2 × B)))
```

The first term responds to projected overspend. The second responds to entering the last 20% of available monthly funds. For `B = 0`, pressure is defined as 1, division is avoided, and all requests are rejected.

Importance `i` is 0 for low, 0.5 for medium, and 1 for high. Given base quality, cost, and latency weights, compute:

```
q′ = q0 × (1 + i)
c′ = c0 + 2p
l′ = l0
(wq, wc, wl) = (q′, c′, l′) / (q′ + c′ + l′)
```

Negative or nonfinite weights are treated as zero; if all adjusted weights are zero, the fallback is `(1, 0, 0)`. The demo defaults are deliberately quality-focused: `(0.80, 0.15, 0.05)` before adjustment, medium importance, and a quality floor of 0.72. On the default analysis request, early and balanced scenarios choose Atlas Pro; tight chooses Spark Mini. These outcomes demonstrate the policy, not empirical superiority.

The team request allowance is `R / max(N, 1) × (1 + i)`. If a user has a monthly budget `U`, remaining user funds are `Ru = max(U − userSpent − userReserved, 0)`. Opening team spend is not assigned to that user. The prototype assumes equal future workload among the `k` team members and computes a user allowance `Ru / max(N / max(k, 1), 1) × (1 + i)`. The final hard cap is:

```
cap = min(R, team request allowance, explicit request cap if supplied,
          Ru if configured, user allowance if configured)
```

Importance therefore cannot exceed remaining funds or an explicit user limit. Zero or exhausted team/user budgets reject all requests, including free local requests. An explicit request cap of zero can admit a free local request while its team and user budgets remain positive. Nonexistent user IDs are rejected.

## Model filtering and ranking

Estimated input tokens are `max(ceil(prompt.length / 4), 1)`; output tokens are the configured output allowance, rounded up. This is a transparent approximation, not a tokenizer. Model cost is:

```
cost = (inputTokens × inputPrice + outputTokens × outputPrice) / 1,000,000
```

The engine filters team and request blocklists, execution mode, local-only privacy, context capacity, task quality floor, and the hard cost cap. A strict latency target is also a hard filter; otherwise latency remains a score penalty. Simulation selects only fictional nonlocal profiles. Local mode selects only local profiles. Uncalibrated local quality is zero, so a user must explicitly set the floor to zero to collect calibration answers. Budget rejection never relaxes constraints or silently lowers a floor.

For an eligible model with task quality `Q` and estimated latency `L`:

```
score = wq × Q − wc × clip(cost / cap) − wl × clip(L / target, 0, 2)
```

When `cap = 0`, a free candidate has cost penalty zero and a nonfree candidate has penalty one (and is ineligible). When the latency target is zero, zero latency has zero penalty and positive latency has penalty two. Ranking sorts by score descending, then preference, cost ascending, and model ID. Preferences only resolve exact score ties and never override hard restrictions. `buildPreview` is deterministic and reports zero internal routing time; callers may time execution externally.

Quality and latency constraints concern estimates. Real generated quality and latency can differ, and token estimates can be inaccurate. Local execution and human ratings are distinguished from simulated cloud profiles in the application.

## Human quality ratings

Each answer receives correctness, completeness, and instruction-following ratings in `[1, 5]`. Their equal-weight score is `(mean rating − 1) / 4`. Thus all 1s yield 0, all 4s yield 0.75, and all 5s yield 1. Invalid/nonfinite ratings are rejected. A human score is evidence about that answer; aggregate per-task estimates remain limited by the number and representativeness of ratings.

## Held-out offline evaluation

Forty hand-authored prompts cover coding, analysis, writing, and Q&A equally. The first five per task are calibration prompts, with answer-specific rubrics; the last five are held out. `evaluate` replays only the 20 evaluation prompts. It does not produce answers, contact model providers, use calibration answers as evaluation evidence, or claim measured model quality.

Every strategy starts at the same opening spend, with zero new user spend and zero observed replay completions. Each completion deducts its estimated cost. All strategies honor explicit quality and strict-latency requirements, blocklists, context limits, privacy, user limits, and the monthly budget. Their selection rules differ:

- **Strongest:** highest eligible task quality, without the adaptive per-request share.
- **Cheapest:** lowest eligible cost, without the adaptive per-request share.
- **Fixed:** unchanged normalized base weights, with an explicit request cap or the static `B / max(monthlyRequests, 1)` cap.
- **Adaptive:** the full pressure- and importance-adjusted policy and allowance.

For every baseline completion, constraint satisfaction is checked against the original adaptive policy at that strategy's own running ledger state. It can therefore fail the adaptive allowance while obeying the baseline's stated restrictions. The metric is satisfying completions divided by submitted prompts; rejections do not count as satisfying completions. Completion rate is separately completed/submitted. Quality-pass rate uses completed prompts as denominator. Average cost and mean quality likewise concern completed prompts. Empty quality/latency statistics are `null`, not fabricated zero measurements.

Reported model latency uses linear-interpolated median and 95th percentile of illustrative profile latency in seconds. Local routing overhead is actually timed with `performance.now()` and reported as mean milliseconds per submitted request; it includes comparison-policy computation. It is environment-dependent and is not model inference latency. Quality over time preserves prompt positions with `null` for each rejected request.

Savings are `1 − strategyCost / strongestCost` only when the exact completed prompt IDs match the strongest baseline and its cost is positive. Otherwise savings are `null`; dropping work cannot create a misleading savings claim. Costs, quality, and model latency are illustrative simulation metrics. Only a later real evaluation on generated held-out answers with human ratings could support empirical performance conclusions.
