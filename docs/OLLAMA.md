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

`qwen3.5-judge` is `qwen3.5:4b` with a 16k context and shares its weights. The judge thinks before it answers, and with Ollama's default 4096-token context the thinking can fill the window and return an empty verdict.

Start the server so that only one model is loaded at a time:

```sh
OLLAMA_MAX_LOADED_MODELS=1 ollama serve
```

On a 16 GB card the three Gemma models do not fit at once: 12b takes about 8.7 GB, 4b about 3.8 GB, and the desktop about 1 GB. If Ollama keeps them all, 1b is pushed onto the CPU and its measured latency is about five times too high. With one model loaded, every model runs fully on the GPU. Switching models in Stage B/C then adds a few seconds of load time, which both systems pay.

## 2. Start the gateway

```sh
python3 -m venv .venv
.venv/bin/pip install 'litellm[proxy]'
export LITELLM_MASTER_KEY=choose-a-local-password
.venv/bin/litellm --config eval/litellm/ollama.yaml --host 127.0.0.1 --port 4000
```

## 3. Configure Orchestra

Put these lines in `.env.local`, using the same `LITELLM_MASTER_KEY`:

```sh
ORCHESTRA_POOL=ollama
LITELLM_URL=http://127.0.0.1:4000/v1/chat/completions
LITELLM_MASTER_KEY=choose-a-local-password
JUDGE_BASE_URL=http://127.0.0.1:11434/v1
JUDGE_MODEL=qwen3.5-judge
```

`ORCHESTRA_POOL` turns gateway mode on. Without it, the app never contacts a gateway.

## 4. Smoke test

```sh
EVAL_EXECUTION=real EVAL_LIMIT=1 node --env-file=.env.local --import tsx eval/stage-b/run.ts
```

This runs one scenario through both systems and shows the time per request on your machine. The result goes to `eval/results/stage-b/real-ollama-results.json`. That file is gitignored and never mixes with OpenAI results.

## 5. Calibrate before routing

All three aliases share an uncalibrated quality estimate of 0.75. Until you calibrate, Orchestra always picks the cheapest model. Calibration runs the 20 calibration prompts on each model (60 generations) and judges them:

```sh
node --env-file=.env.local --import tsx eval/calibration/run.ts
```

The script writes measured per-task quality and latency to `eval/results/calibration/ollama-quality.json`, and keeps raw answers in `ollama-runs.json`. Orchestra reads the quality file on every routing decision, in the Request lab and in Stage B/C. Commit it so teammates route on the same numbers. Held-out evaluation prompts are never used for calibration.

Generation uses a 1024-token output cap (`EVAL_OUTPUT_TOKEN_CAP`). Every gateway call also sends the system instruction `ANSWER_LENGTH_INSTRUCTION` ("Answer in at most about 300 words"). That applies to calibration, both Stage B/C systems, and the Request lab, and the judge is told not to penalize that concision. At a 256-token cap, 56 of 60 calibration answers were cut off. At 1024 with no length instruction, 23 of 60 still were, mostly from 12b. In both cases the judge scored the truncation rather than the answer.

Stage B/C use a quality floor of 0.75. If calibration scores a model below that floor for a task, Orchestra will not choose it for that task.

## 6. Stage B and C

Run everything, from calibration to the metrics report, with one command:

```sh
bash eval/run-ollama-study.sh
```

It takes about two hours on an RTX 5080. Every step resumes from its checkpoint, so rerun the script after an interruption. The individual steps are:

```sh
# Stage B: 60 scenarios × 2 systems
EVAL_EXECUTION=real node --env-file=.env.local --import tsx eval/stage-b/run.ts
EVAL_EXECUTION=real node --env-file=.env.local --import tsx eval/stage-b/evaluate.ts
EVAL_MODE=real node --env-file=.env.local --import tsx eval/stage-b/judge.ts

# Stage C: 200 sequential requests × 2 systems
EVAL_EXECUTION=real node --env-file=.env.local --import tsx eval/stage-c/run.ts
EVAL_EXECUTION=real node --env-file=.env.local --import tsx eval/stage-c/validate.ts
EVAL_MODE=real node --env-file=.env.local --import tsx eval/stage-c/judge.ts

# Metrics: budget compliance, exhaustion timing, quality over time,
# model choice by budget state, and efficiency
EVAL_EXECUTION=real node --env-file=.env.local --import tsx eval/report.ts
```

The report is saved to `eval/results/stage-c/real-ollama-report.json`.

Stage C's budget is $0.40 for 200 requests. It was $1. With answers near 300 words, 200 requests on 12b cost about $0.78, so $1 never constrained either system.

The local pool needs no `EVAL_LIMIT`, because it cannot incur charges. Every script resumes from its checkpoint.

Stage C refuses to resume a file made with a different `EVAL_LIMIT`. Delete `eval/results/stage-c/real-ollama-results.json` after a smoke test before you start the full run. The Stage C judge reuses one judgment for identical answers to repeated prompts.

Changing the pool, calibration, or policy changes the experiment, so start from fresh result files. To measure variance, repeat the full run two or three times. LiteLLM's adaptive router learns from earlier requests, so baseline choices can differ between runs.

## 7. Request lab

Start the app (`npm run dev`) and choose **Execution mode → Gateway models**. The default workspace budget ($1,000 for 10,000 requests) allows about $0.57 per request, while a gateway request costs $0.0001–$0.01. At that budget, cost barely affects routing. To see the policy move to cheaper models as the budget tightens, set **Monthly budget** to about $2–$5. Gateway runs use the workspace scenario budget, including the 10% / 50% / 92% scenarios, and charge shadow prices to a separate gateway ledger. History shows the returned model and the shadow cost. Simulation and Ollama-direct modes are unchanged.

## Known limits

- The baseline `smart-router` uses LiteLLM's adaptive router. It has not yet been verified against Ollama models; the smoke test is the first check.
- `qwen3.5-judge` is a thinking model, so judging is slower than generation. A small local judge is weaker than a hosted one and may still favor some answer styles.
- Measured latency includes model swaps if Ollama has to reload a model. Calibration sends one warm-up request per model before it measures.
