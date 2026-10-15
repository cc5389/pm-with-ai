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
p = max(clip(projectedSpend / B − 1), clip(1 − R / (t × B)))
```

The first term responds to projected overspend. The second responds when remaining funds fall below fraction `t` of the monthly budget (20% by default). For `B = 0`, pressure is defined as 1, division is avoided, and all requests are rejected.

Agent1 v1.1 uses saved company rules. These defaults preserve the original v1.0 calculations:

| Rule                         | Default | Permitted values            |
| ---------------------------- | ------- | --------------------------- |
| Low-balance threshold `t`    | 0.20    | 0.05–0.50                   |
| Cost pressure strength `a`   | 2       | 0–5                         |
| Low importance multiplier    | 1       | Fixed                       |
| Medium importance multiplier | 1.5     | 1–3                         |
| High importance multiplier   | 2       | Medium multiplier through 3 |

Importance is chosen per request: how much extra budget and quality preference this work deserves. Low suits routine brainstorming, Medium regular business work, and High urgent customer issues. These are examples; task category does not automatically determine importance. Budget pressure never changes the chosen importance or quality floor.

Let `m` be the selected importance multiplier. Given base quality, cost, and latency weights, compute:

```
q′ = q0 × m
c′ = c0 + a × p
l′ = l0
(wq, wc, wl) = (q′, c′, l′) / (q′ + c′ + l′)
```

Negative or nonfinite weights are treated as zero; if all adjusted weights are zero, the fallback is `(1, 0, 0)`. The demo defaults are deliberately quality-focused: `(0.80, 0.15, 0.05)` before adjustment, medium importance, and a quality floor of 0.72. On the default analysis request, early and balanced scenarios choose Atlas Pro; tight chooses Spark Mini. These outcomes demonstrate the policy, not empirical superiority.

The team request allowance is `R / max(N, 1) × m`. If a user has a monthly budget `U`, remaining user funds are `Ru = max(U − userSpent − userReserved, 0)`. Opening team spend is not assigned to that user. The prototype assumes equal future workload among the `k` team members and computes a user allowance `Ru / max(N / max(k, 1), 1) × m`. The final hard cap is:

```
cap = min(R, team request allowance, explicit request cap if supplied,
          Ru if configured, user allowance if configured)
```

Importance therefore cannot exceed remaining funds or an explicit user limit. Zero or exhausted team/user budgets reject all requests, including free local requests. An explicit request cap of zero can admit a free local request while its team and user budgets remain positive. Nonexistent user IDs are rejected.

## Worked calculation and interactive controls

Suppose the monthly budget is $100, settled spend is $20, reservations are zero, and 1,600 requests are expected before month end. Remaining funds are $80, so the base allowance is $80 / 1,600 = $0.05. Default Low, Medium and High importance produce team allowances of $0.05, $0.075 and $0.10. An explicit $0.04 request cap makes all three final allowances $0.04. The inspector lists every limit tied for the smallest value.

At zero pressure with base weights `(0.80, 0.15, 0.05)`, Medium importance produces raw adjusted weights `(1.20, 0.15, 0.05)` and normalized weights `(0.857143, 0.107143, 0.035714)`. A zero base quality weight stays zero when multiplied; the quality floor remains enforced independently. Equal multipliers or binding caps can make importance changes leave some results unchanged.

For another example, if $10 remains from a $100 budget late in the month and the forecast does not exceed the budget, default low-balance pressure is `1 − 10 / (0.2 × 100) = 0.5`. Setting the threshold to 50% yields pressure `0.8`. Setting cost pressure strength to zero removes its effect on routing weights, while spending caps still apply.

The Company policy editor previews rule changes after 300 ms. Save company policy explicitly before running; saving it also saves any valid budget draft. Save budget alone retains policy edits as unsaved drafts. Empty or invalid inputs pause calculations. Reset to defaults changes the draft; it does not silently save. Low/Medium/High comparisons use identical budget and request inputs, differing only in importance. Previews never call a model or update the ledger.

New policies use version 1.1 and retain a snapshot of effective rules, intermediate calculations, and importance comparisons. History displays those saved values. Old version 1.0 records remain readable without being recalculated. Existing workspaces and API settings without company rules receive the defaults above.

These formulas are explicit heuristic design choices, not an empirically optimized policy. Multiplying allowances for important work does not reserve a planned share for each priority. If every request is High, funds may run out earlier. The 20-completion switch, linear spending forecast, equal expected usage across users, and cold-start seed are v1 assumptions to evaluate later. The defaults are the reproducible v1 policy; experiments should save any tuned rules as part of their configuration.

## Agent1 boundary and evaluation handoff

`derivePolicy(input, settings, context, coldStartProjectedSpend)` in `lib/policy.ts` is pure. The last argument is an externally supplied full-month USD estimate used only at cold start. The website supplies monthly volume times mean estimated profile cost. Agent1 needs no model catalog, router, provider connection, database, or LiteLLM integration. It returns budget constraints, weights and calculation details. The preview engine separately filters and ranks models, populating the existing allowed-model list.

Jiwon's Stage B/C runners currently use mocks and are unchanged. A future real Orchestra adapter should call the same policy function with evaluation-provided state; the runner owns observed spending updates. The evaluation currently supplies budget, spending, importance and quality floor, so integration must explicitly specify calendar dates, request volume, reservations, user context, base weights and company rules. Do not inherit mutable website settings in a real experiment. Preserve policy version and effective rules with results, check that resumed runs use the same configuration, and add a check for the per-request allowance alongside the existing remaining-budget check. Actual generated costs may differ from estimates.

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
