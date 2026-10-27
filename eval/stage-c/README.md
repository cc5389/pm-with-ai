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

With the existing gateway, pool, credentials, and optional calibration configured,
run the full comparison later (200 requests per configuration):

```sh
export EVAL_EXECUTION=real
export EVAL_LIMIT=200
export STAGE_C_BUDGET_USD=0.10
export STAGE_C_VARIANT=all
export STAGE_C_RUN_ID=full-010-v2
node --import tsx eval/stage-c/run.ts
node --import tsx eval/stage-c/validate.ts
node --import tsx eval/stage-c/judge.ts
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
