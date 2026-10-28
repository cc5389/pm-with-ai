# Free end-to-end runs with Ollama

Orchestra can route real requests to local open-weight models through a local LiteLLM gateway. The Request lab and Stage B/C both use it. Nothing is billed. Each model has a **shadow price** that borrows the gpt-4.1 price of the same tier, so the budget still constrains routing.

| Role               | Model                                                                      | Shadow price (per million input / output tokens) |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------ |
| Tier 1 (cheapest)  | `gemma3:1b` as `gemma3-1b`                                                 | $0.10 / $0.40 (gpt-4.1-nano)                     |
| Tier 2             | `gemma3:4b` as `gemma3-4b`                                                 | $0.40 / $1.60 (gpt-4.1-mini)                     |
| Tier 3 (strongest) | `gemma3:12b` as `gemma3-12b`                                               | $2.00 / $8.00 (gpt-4.1)                          |
| Quality judge      | `qwen3.5-judge` (`qwen3.5:4b` with a 16k context), from a different family | not charged                                      |

The pool is defined in `eval/shared/model-pool.ts` (`MODEL_POOLS.ollama`) and `eval/litellm/ollama.yaml`. Shadow prices cannot support a claim of real savings. Report them as "shadow-priced open-weight models".

## 1. Install the models

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma3:1b
ollama pull gemma3:4b
ollama pull gemma3:12b
ollama pull qwen3.5:4b
ollama create qwen3.5-judge -f eval/litellm/judge.Modelfile
```

`qwen3.5-judge` is `qwen3.5:4b` with a 16k context and shares its weights. Stage C disables thinking on every local judging attempt via `reasoning_effort: "none"`. The larger context leaves room for the rubric, answer, and JSON verdict.

Start the server so that only one model is loaded at a time:

```sh
OLLAMA_MAX_LOADED_MODELS=1 ollama serve
```

On a 16 GB card the three Gemma models do not fit at once: 12b takes about 8.7 GB, 4b about 3.8 GB, and the desktop about 1 GB. If Ollama keeps them all, 1b is pushed onto the CPU and its measured latency is about five times too high. With one model loaded, every model runs fully on the GPU. Switching models in Stage B/C then adds a few seconds of load time, which both systems pay.

## 2. Start the gateway

```sh
python3 -m venv .venv
.venv/bin/pip install 'litellm[proxy]'
# Generate a private key once, then store it in ignored .env.local for the client.
export LITELLM_MASTER_KEY="$(openssl rand -hex 32)"
.venv/bin/litellm --config eval/litellm/ollama.yaml --host 127.0.0.1 --port 4000
```

## 3. Configure Orchestra

Put these lines in `.env.local`, using the same `LITELLM_MASTER_KEY`:

```sh
ORCHESTRA_POOL=ollama
LITELLM_URL=http://127.0.0.1:4000/v1/chat/completions
LITELLM_MASTER_KEY=<same-private-value-as-the-gateway>
JUDGE_BASE_URL=http://127.0.0.1:11434/v1
JUDGE_MODEL=qwen3.5-judge
JUDGE_TIMEOUT_MS=600000
LITELLM_TIMEOUT_MS=600000
ORCHESTRA_CALIBRATION_PATH=eval/results/calibration/ollama-quality.json
```

`.env.local` is ignored by Git. The LiteLLM server reads `general_settings.master_key`
from `LITELLM_MASTER_KEY`; the evaluation client sends the same value as its bearer
credential. Setting a key in only one process, or generating a different key for each,
causes authentication failures. Node evaluation scripts explicitly load `.env.local`
with `--env-file`; the gateway needs the key in its own process environment.

Client and judge timeouts are positive integer milliseconds, defaulting to 600,000.
The gateway's per-model `timeout: 600` values in `eval/litellm/ollama.yaml` are in
seconds and can be increased there for slower inference. If increasing the server
limit, increase the client's `LITELLM_TIMEOUT_MS` too. A timeout may have reached
Ollama; it is recorded as an unresolved reservation rather than a free retry.

`ORCHESTRA_POOL` turns gateway mode on. Without it, the app never contacts a gateway.

## 4. Smoke test

```sh
EVAL_EXECUTION=real EVAL_LIMIT=1 node --env-file=.env.local --import tsx eval/stage-b/run.ts
```

This runs one scenario through both systems and shows the time per request on your machine. The result goes to `eval/results/stage-b/real-ollama-results.json`. It never mixes with OpenAI results. The committed `real-ollama-*` files hold a full reference run, so move them aside before a smoke test (see section 6).

## 5. Calibrate before routing

All three aliases share an uncalibrated quality estimate of 0.75. Until you calibrate, Orchestra always picks the cheapest model. Calibration runs the 20 calibration prompts on each model (60 generations) and judges them:

```sh
node --env-file=.env.local --import tsx eval/calibration/run.ts
```

The script writes measured per-task quality and latency to `eval/results/calibration/ollama-quality.json`, and keeps raw answers in `ollama-runs.json`. Orchestra reads the quality file on every routing decision, in the Request lab and in Stage B/C. Commit it so teammates route on the same numbers. Held-out evaluation prompts are never used for calibration.

Generation uses a 1024-token output cap (`EVAL_OUTPUT_TOKEN_CAP`). Every gateway call also sends the system instruction `ANSWER_LENGTH_INSTRUCTION` ("Answer in at most about 300 words"). That applies to calibration, both Stage B/C systems, and the Request lab, and the judge is told not to penalize that concision. At a 256-token cap, 56 of 60 calibration answers were cut off. At 1024 with no length instruction, 23 of 60 still were, mostly from 12b. In both cases the judge scored the truncation rather than the answer.

Stage B/C use a quality floor of 0.75. If calibration scores a model below that floor for a task, Orchestra will not choose it for that task.

## 6. Stage C on the RTX 5080

Use the existing committed `eval/results/calibration/ollama-quality.json` for this
comparison. Do not rerun calibration or change the measured scores to avoid
rejections. Calibration was measured on another run; hardware and model-loading
latency can differ on your machine.

```sh
export EVAL_EXECUTION=real
export EVAL_LIMIT=200
export STAGE_C_BUDGET_USD=0.10
export STAGE_C_VARIANT=all
export STAGE_C_RUN_ID=rtx5080-stage-c-001
node --env-file=.env.local --import tsx eval/stage-c/run.ts
node --env-file=.env.local --import tsx eval/stage-c/validate.ts
node --env-file=.env.local --import tsx eval/stage-c/judge.ts
```

This runs 200 requests per variant: `baseline`, `orchestra-fixed`, and
`orchestra-inferred`. Each has its own $0.10 shadow budget. The 0.75 floor and
1,024-token output cap stay fixed. Use a new run ID for a fresh experiment; reuse
one only to resume. Files include mode, pool, budget, variant selection, and run ID.
For this example the report is
`eval/results/stage-c/real-ollama-v2-budget-0.1-all-rtx5080-stage-c-001-report.json`.
No deletion or moving of original experiments is required. Different workload limits
cannot resume the same checkpoint. Recorded configuration fingerprints prevent
mixing changed workload/calibration/profile settings in a new checkpoint.

The first five coding prompts are expected to be rejected by inferred importance:
medium importance gives a $0.0015 allowance at zero spend, Gemma 4B costs about
$0.00165 at the full output cap, and Gemma 1B's measured coding quality is 0.70.
Fixed high importance gives a $0.002 allowance and can admit 4B initially. This is
a policy outcome to report, not a provider failure or a reason to relax constraints.
The full workload includes other categories, so the five-request outcome does not
imply the entire inferred run will be rejected.

Reports distinguish successful generations, provider failures, policy rejections,
unresolved reservations, judged-response pass rate, and overall successful-service
rate (quality-passing responses divided by all submitted requests). The latter is
null until every successful generation has a judgment; all-rejected variants have
zero service rate and null judged-response pass rate. See `eval/stage-c/README.md`
for prediction timing, checkpoint recovery, and report denominators.

Stage B and the historical `eval/report.ts` retain their legacy output paths.
`eval/run-ollama-study.sh` is the broader legacy workflow: it includes calibration
and Stage B. Do not use it for this frozen-calibration Stage C handoff or use its
legacy report to summarize v2 variants. Preserve all archived reference results.

## 7. Request lab

Start the app (`npm run dev`) and choose **Execution mode → Gateway models**. The default workspace budget ($1,000 for 10,000 requests) allows about $0.57 per request, while a gateway request costs $0.0001–$0.01. At that budget, cost barely affects routing. To see the policy move to cheaper models as the budget tightens, set **Monthly budget** to about $2–$5. Gateway runs use the workspace scenario budget, including the 10% / 50% / 92% scenarios, and charge shadow prices to a separate gateway ledger. History shows the returned model and the shadow cost. Simulation and Ollama-direct modes are unchanged.

## Known limits

- The baseline `smart-router` uses LiteLLM's adaptive router. It has not yet been verified against Ollama models; the smoke test is the first check.
- Local Qwen judging runs with thinking disabled. A small local judge can still be noisy or favor particular answer styles; it is not a human ground truth.
- Measured latency includes model swaps if Ollama has to reload a model. Calibration sends one warm-up request per model before it measures.
