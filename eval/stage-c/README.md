# Stage C v2

The default budget is $0.10 per independent configuration. The original 200-request
sequence and fixed control labels remain unchanged. Inferred mode uses the reusable
prompt-only `lib/classification.ts` heuristic: effort and consequences are independent,
with confidence, explanation, zero classifier cost, and measured classifier latency.
Confidence is a heuristic signal, not a calibrated probability. Unknown tasks default
to medium with low confidence. No classifier provider is called.

Three configurations run by default: baseline (LiteLLM smart-router), orchestra-fixed,
and orchestra-inferred. Set STAGE_C_VARIANT to any of these to run independently.
STAGE_C_BUDGET_USD must be positive and finite. STAGE_C_RUN_ID identifies a fresh
experiment; reuse it to resume. Results files are also atomic checkpoints. Paths
include v2, execution mode, real model pool, budget, variant selection, and run ID;
legacy results and judgments are never used or modified. A different workload limit
cannot resume an existing checkpoint. Choose a new run ID for a fresh run.

With the existing Ollama gateway, matching private master key, and committed measured calibration configured in ignored `.env.local`,
run the full comparison later (200 requests per configuration):

```sh
export ORCHESTRA_POOL=ollama
export ORCHESTRA_CALIBRATION_PATH=eval/results/calibration/ollama-quality.json
export EVAL_EXECUTION=real
export EVAL_LIMIT=200
export STAGE_C_BUDGET_USD=0.10
export STAGE_C_VARIANT=all
export STAGE_C_RUN_ID=full-010-v2
node --env-file=.env.local --import tsx eval/stage-c/run.ts
node --env-file=.env.local --import tsx eval/stage-c/validate.ts
node --env-file=.env.local --import tsx eval/stage-c/judge.ts
```

The judge uses the existing JUDGE_MODEL, JUDGE_BASE_URL, JUDGE_API_KEY / OPENAI_API_KEY
configuration. Its cost is separate from each configuration's generation budget.
The judge writes judgments and the quality report to matching versioned filenames.
Generation writes a trajectory report even before judging; it does not fabricate
observations. Resuming generation preserves existing report judgments.

Predictions use the pool's per-category calibration estimates when available, otherwise
its existing planning estimates. Orchestra captures selected estimated quality before
calling the gateway. LiteLLM selects internally, so baseline predictions are looked up
for its returned model from a profile snapshot frozen before the call; unknown models
have no prediction. No response score enters policy selection. Difficulty is recorded,
while inferred importance changes Agent 1's allowance and quality weighting.

Reports group by variant, selected model, effective importance, original task category,
and pre-request utilization quartile. Rejections and generation failures are separate.
Observed pass and violation rates use judged successful responses only. Paired means
include only judged successful responses with a prediction; pairedCount documents
coverage. Missing judgments produce null rates, never zero scores. Trajectories include
cumulative spend, utilization, model counts, switches between consecutive model
selections (ignoring rejected requests), and the first budget-related rejection's
zero-based sequenceIndex. Mock responses are never judged as real quality evidence.

Local verification smoke run (use a new run ID for fresh records):

```sh
EVAL_EXECUTION=mock EVAL_LIMIT=5 STAGE_C_BUDGET_USD=0.10 STAGE_C_RUN_ID=smoke-new node --import tsx eval/stage-c/run.ts
EVAL_EXECUTION=mock STAGE_C_BUDGET_USD=0.10 STAGE_C_RUN_ID=smoke-new node --import tsx eval/stage-c/validate.ts
```

## Audit and handoff notes

Local Qwen judging disables thinking on every attempt, including format retries.
`JUDGE_TIMEOUT_MS` and `LITELLM_TIMEOUT_MS` are configurable positive integer
milliseconds; each defaults to 600,000. Invalid values fail before provider calls.
The gateway's per-model timeout is 600 seconds in `eval/litellm/ollama.yaml`;
increase both server and client limits together if needed. The gateway reads its
master key from the environment, and the client must use that same private value.
Never commit `.env.local` or a real credential.

The runner durably saves a `pendingAttempt` with predicted quality, the entire
quality snapshot, selected/requested alias, and reservation before sending a real
generation request. An interrupted pending attempt blocks automatic recovery until
its outcome is reconciled. Do not simply clear it: determine whether the provider
completed or charged it, record the matching result and cost, and then resume. When
cost is unresolved but a reservation is known, the saved result keeps that amount
locked (`costBasis: unresolved`) and the completed sequence position is not retried.
The report counts those reservations separately from known measured costs. Null
cost rows still block resume. New checkpoint fingerprints bind workload, model
profiles/calibration, policy rules, output cap, and classifier version; legacy v2
files without fingerprints retain their original recovery checks.

Baseline uses LiteLLM's internal selection. Its chosen model cannot be known before
the gateway responds; the **whole model-quality snapshot** is persisted beforehand
and the returned model is joined to that snapshot afterward. `predictionTiming`
makes this distinction explicit. Orchestra persists its actual selected model's
prediction before generation. This prevents observed Qwen scores from entering
routing decisions.

The frozen first five coding prompts all infer medium importance and are correctly
rejected at $0.10: their allowance is $0.0015, the 4B full-cap estimates range from
$0.001648 to $0.0016496, and the affordable 1B coding score is 0.70 (below 0.75).
Fixed high importance has a $0.002 initial allowance. No budget, floor, cap, or
calibration was changed to mask these rejections. This five-request smoke test
covers coding only; use the complete 200-request workload for category comparisons.

Each report group now includes `successfulGenerations`, `providerFailures`,
`policyRejections`, `unresolvedCosts`, `generationSuccessRate`, `judgmentCoverage`,
and `overallSuccessfulServiceRate`. Existing `failed`/`rejected` fields remain for
compatibility. Overall successful-service rate is quality-passing responses divided
by **all submitted requests**, and is null while any successful response remains
unjudged. For an all-rejected variant it is zero, while observed pass rate is null.

Historical pilots, failed local attempts, backups, and generated smoke results are
preserved locally and excluded from the handoff commit. Use this v2 runner/judge's
report; `eval/report.ts` and `eval/run-ollama-study.sh` are legacy broader workflows
and do not provide the three-variant frozen-calibration comparison.
