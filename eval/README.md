# Orchestra — Evaluation Framework

## Overview

This directory contains the evaluation framework for **Orchestra: Budget-Aware LLM Routing**.

The project evaluates whether adding a budget-aware policy layer to LiteLLM improves routing decisions under organizational budget constraints.

The main comparison is:

- **Baseline (B2):** LiteLLM adaptive routing without Orchestra's budget-aware policy.
- **Orchestra (B3):** Budget-aware policy layer + the same LiteLLM routing setup.

The evaluation framework is separate from the policy implementation. It is responsible for constructing experimental workloads, executing requests, recording results, tracking spending, and evaluating quality and constraint compliance.

## 1. Evaluation Stages

| Stage | Purpose | Experimental setup |
|---|---|---|
| Stage A | Router selection | LiteLLM vs. Not Diamond |
| Stage B | Single-request comparison | Baseline vs. Orchestra at fixed budget states |
| Stage C | Sequential workload comparison | Baseline vs. Orchestra over 200 requests with changing budget states |

### Stage A — Router Selection

Stage A compared LiteLLM and Not Diamond using the existing benchmark prompts, measuring response quality, generation cost, and latency.

LiteLLM was selected as the underlying router for subsequent experiments.

Stage A results and scripts are located in `eval/stage-a/` and `eval/results/stage-a/`.

### Stage B — Fixed-State Evaluation

Stage B evaluates individual routing decisions under three predetermined organizational budget utilization states:

- 10% — low budget utilization
- 50% — moderate budget utilization
- 92% — near budget exhaustion

The current scenario generator uses 20 held-out evaluation prompts across three budget states, producing 60 scenarios per system and 120 generation executions total.

Each request is independent. Spending from one request does not affect another scenario's starting budget.

**Metrics:**
- Response quality and quality pass rate
- Generation cost
- Latency
- Allowed-model compliance
- Observed budget feasibility
- Policy application status

### Stage C — Sequential Evaluation

Stage C evaluates how routing decisions change over a sequence of requests as the organizational budget is consumed.

The initial workload contains 200 requests, generated deterministically by replaying the 20 held-out evaluation prompts.

Both systems receive the same request sequence but maintain independent budget histories.

For each request:

1. Read the current organizational budget state.
2. Pass the request and budget state to the system.
3. Record the model selection, response, latency, and generation cost.
4. Update cumulative spending using the observed generation cost.
5. Save the result and the before/after budget states.

**Metrics and outputs:**
- Cumulative generation cost
- Budget utilization trajectory
- Budget exhaustion and overspending
- Selected model per request
- Latency and response quality
- Constraint compliance

The current workload is a repeated-prompt simulation rather than a diverse production traffic sample.

## 2. Directory Structure

```text
eval/
├── README.md
│
├── shared/
│   ├── pipeline.ts
│   ├── integrated-adapter.ts
│   ├── judge.ts
│   └── metrics.ts
│
├── stage-a/
│   ├── adapters/
│   ├── run-evaluation.ts
│   └── judge-evaluation.ts
│
├── stage-b/
│   ├── scenarios.ts
│   ├── mock-adapter.ts
│   ├── run.ts
│   ├── constraints.ts
│   ├── evaluate.ts
│   └── judge.ts
│
├── stage-c/
│   ├── workload.ts
│   ├── budget.ts
│   ├── run.ts
│   └── validate.ts
│
└── results/
    ├── stage-a/
    ├── stage-b/
    └── stage-c/
```

The directory may contain additional existing files not shown here.

## 3. Shared Interfaces

### `shared/pipeline.ts`

Defines the shared evaluation data structures:

- `EvaluationRequest` — prompt, task, rubric, scenario ID, and organization state
- `OrganizationState` — total budget, cumulative spending, utilization, task importance, and quality floor
- `EvaluationResult` — generation output, system identity, policy metadata, and budget states
- `EvaluationAdapter` — common interface for executing a request through either system

### `shared/integrated-adapter.ts`

Provides the integration wrapper for real pipeline implementations.

Both baseline and Orchestra implementations must conform to the same interface.

The wrapper validates basic response properties and preserves system identity.

### `shared/judge.ts`

Contains the existing LLM-based quality judge reused from Stage A.

The Stage B judging script additionally records `scenarioId` and `system` so repeated prompts and different systems are distinguishable.

## 4. Stage B Files

| File | Responsibility |
|---|---|
| `scenarios.ts` | Generate fixed-budget experimental scenarios |
| `mock-adapter.ts` | Provide synthetic responses for framework testing |
| `run.ts` | Execute scenarios for both systems and checkpoint results |
| `constraints.ts` | Evaluate model and budget constraints |
| `evaluate.ts` | Run offline constraint checks |
| `judge.ts` | Evaluate real responses using the LLM quality judge |

`run.ts` uses mock adapters unless `EVAL_EXECUTION=real`. A real run also requires `EVAL_LIMIT`, so an unbounded paid run cannot start by accident.

## 5. Stage C Files

| File | Responsibility |
|---|---|
| `workload.ts` | Generate a deterministic sequential workload |
| `budget.ts` | Track cumulative spending and remaining budget |
| `run.ts` | Execute sequential requests with independent budgets |
| `validate.ts` | Validate saved budget trajectories |

`run.ts` uses mock adapters unless `EVAL_EXECUTION=real` and `EVAL_LIMIT` are both set.

The budget tracker records observed spending but does not itself enforce routing or budget restrictions.

## 6. Integration Contract for Policy and Router Teams

The evaluation framework expects two asynchronous pipeline functions:

**Baseline**

```ts
async function runBaseline(
  request: EvaluationRequest
): Promise<PipelineExecution>
```

**Orchestra**

```ts
async function runOrchestra(
  request: EvaluationRequest
): Promise<PipelineExecution>
```

Both functions use the same gateway config, model pool, prompts, output cap, and starting budgets. They do not share a second router.

The baseline calls LiteLLM with the Stage A alias `smart-router` and does not apply Orchestra's score. In `eval/stage-a/litellm/config.yaml`, `smart-router` is `auto_router/adaptive_router`. The gateway then chooses among `gpt-4.1`, `gpt-4.1-mini`, and `gpt-4.1-nano` using its own weights (quality 0.7, cost 0.3) and can ignore Orchestra's budget and quality floor. Before that call, the runner still reserves the most expensive model in the pool at the shared output cap. If the remaining budget cannot cover that reservation, the baseline rejects the request and does not call the gateway.

Orchestra calls `buildPreview` in `lib/engine.ts`. The HTTP `model` field is the selected alias (`gpt-4.1`, `gpt-4.1-mini`, or `gpt-4.1-nano`), never `smart-router`. Returned ids are accepted only from an explicit list, including the versioned ids in the gateway config (`gpt-4.1-2025-04-14` and its mini and nano counterparts, with or without the `openai/` prefix). A genuinely different model is a failure, and both names are kept. The reservation is input tokens plus the full output cap. If the provider may have charged but did not report a price, that reservation stays locked and is labeled unresolved. A known cost is kept even when the returned model is rejected.

All three aliases share one uncalibrated quality estimate of 0.75, so that estimate does not remove nano from the pool. Latency figures are also estimates. The baseline still cannot force `smart-router` to honor Orchestra's eligible set. Reports label this as a comparison of two policies. They do not claim to isolate routing quality. Prices used for the reservation are the frozen 2026-10-07 snapshot. A response cost header is recorded as actual; otherwise a price-table calculation is labeled estimated.

The input includes:

- Prompt and task type
- Request and scenario identifiers
- Organizational budget and spending
- Budget utilization fraction
- Task importance
- Quality floor

The output must include:

- Selected model
- Generated response
- Success or error information
- Generation latency
- Input and output token counts, when available
- Generation cost in USD
- Policy metadata, when applicable

**Important integration rules:**

1. Do not independently update organizational spending inside the pipeline functions. The evaluation runner owns budget accounting.
2. Preserve the original request ID.
3. Return actual measured costs and latency, not mock values.
4. Preserve policy decisions and allowed-model restrictions in the returned metadata.
5. Use the same gateway, model pool, prompts, output cap, and starting budgets. Do not send Orchestra's selected alias through `smart-router`.

## 7. Running the Evaluation Framework

Run commands from the project root.

### TypeScript validation

```bash
npm run typecheck
```

### Stage B — Mock evaluation

```bash
node --import tsx eval/stage-b/run.ts
node --import tsx eval/stage-b/evaluate.ts
```

### Stage C — Mock evaluation

```bash
node --import tsx eval/stage-c/run.ts
node --import tsx eval/stage-c/validate.ts
```

Mock evaluations require no API credentials. They do not measure provider spend, and their reports must not be cited as savings.

### Stage B or C — one real request

Only after the local gateway is running and you intend to pay:

```powershell
$env:EVAL_EXECUTION = "real"
$env:EVAL_LIMIT = "1"
node --env-file=.env.local --import tsx eval/stage-b/run.ts
```

`EVAL_LIMIT=1` runs the first scenario or workload item through both systems. It is not the full study. Unset `EVAL_LIMIT` makes a real run refuse to start. Real results are written under `eval/results/stage-b/real-*` and `eval/results/stage-c/real-*`, which are gitignored. See [the Windows gateway guide](../docs/LITELLM-WINDOWS.md).

### Stage B — Real quality judging

Only after real generation results have been produced:

```bash
EVAL_MODE=real node --env-file=.env.local --import tsx eval/stage-b/judge.ts
```

This command uses an LLM judge and incurs API costs.

Do not use mock outputs as actual quality evidence.

## 8. Results and Checkpointing

Results are stored in:

```text
eval/results/stage-a/
eval/results/stage-b/
eval/results/stage-c/
```

The Stage B and C mock runners save progress after each completed request, allowing interrupted runs to resume.

Stage C reconstructs cumulative spending from previously recorded generation costs when resuming.

Current output files include:

```text
eval/results/stage-b/mock-results.json
eval/results/stage-b/mock-constraints.json
eval/results/stage-c/mock-results.json
```

Mock files are intended only for evaluation infrastructure testing.

Real evaluation outputs must remain separate from mock results.

## 9. Current Status and Remaining Work

**Implemented in the evaluation scaffold:**
- Shared evaluation interfaces
- Fixed-state Stage B scenario generation
- Deterministic Stage C workload generation
- Mock adapters and execution runners
- Budget accounting
- Offline constraint evaluation
- Stage B quality-judging entry point
- Stage C trajectory validation
- Checkpoint-based execution

**Checkpoint Safety and Failure Handling**

- Stage C checkpoints are written through `shared/checkpoint-io.ts` using temporary-file replacement.
- Existing budget trajectories are validated before resuming execution.
- Failed generations with known reported costs are included in cumulative spending.
- Missing or invalid generation costs stop execution to prevent inaccurate budget accounting.
- Adapter exceptions preserve the last completed checkpoint.
- Unknown provider-side charges and automatic retry behavior remain integration considerations.

**Remaining before real experiments:**
- Provide your own gateway and provider credentials outside this repository
- Decide whether the uncalibrated quality estimates should be replaced with measurements before a full run
- Run real Stage B and Stage C only for a limit you intend to pay for
- Judge real responses separately; generation reports do not contain quality scores
- Freeze the experiment configuration and preserve raw outputs



## 10. Research Notes

- Stage B and Stage C are intended to isolate the effect of adding Orchestra's budget-aware policy to the same underlying router.
- Both systems should receive identical requests and equivalent initial experimental conditions.
- The evaluation framework must not modify the policy implementation.
- Budget tracking uses observed generation costs.
- Repeated benchmark prompts and quality-judge ceiling effects should be acknowledged when interpreting experimental results.
- All final research claims must be based on real evaluation data, not mock results.