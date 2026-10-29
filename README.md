# Orchestra — budget-aware model routing

A class-project prototype with a complete request/policy UI, deterministic Agent 1, an explainable Agent 2, persistent SQLite history, and no required paid API. The project lives in `pm-with-ai`; it is independent of the neighboring robotics repository.

## Run

Install **Node.js 24 or newer**, then:

```sh
npm ci
npm run dev
```

Open **http://localhost:3000**. The app binds to loopback and needs no account or key. For a production build, use `npm run build` then `npm start`. SQLite is created automatically at `data/orchestra.sqlite`; settings and history survive restarts. The app is a single trusted local workspace, not an authenticated public service.

On the development machine used to build this prototype, a temporary Node runtime is available at `/tmp/node-v24.21.0-linux-x64/bin`; prepend it to `PATH` if Node is not otherwise installed. That temporary runtime is not part of the repository and may disappear after reboot.

## Class demonstration

1. Open **Request lab**. In **Your budget**, enter monthly budget, starting spend, as-of date, and expected volume. Balances and the policy recalculate automatically as you type. Use **Save budget** to retain the numbers; running a request also saves them. Empty or invalid fields pause calculation.
2. Enter a prompt and adjust its task category, importance, minimum quality, and preferences. Inspect the automatically updated forecast, allowance, weights, and model selection. **Company policy** lets you tune the low-balance threshold, cost pressure strength, and importance multipliers. The policy inspector shows each calculation, every binding spending limit, and a Low/Medium/High comparison. Save company policy before running with changed rules; Reset to defaults only changes the draft. **Preview routing** remains available to refresh manually. Neither automatic nor manual previews record spending.
3. Compare the same request in the **10%, 50%, and 92%** scenarios. Dates change along with consumption so forecasts account for time left in the month.
4. Choose **Run simulation**. The selected candidate and a clearly labeled placeholder are stored. This does not call a model or answer the prompt.
5. Open **History** to inspect the recorded decision, or **Evaluation** to compare adaptive routing with strongest-only, cheapest-only, and fixed-policy baselines.
6. Use **Workspace** to change monthly budget, expected volume, initial simulated spending, users, and model restrictions. Export JSON or CSV to retain results.

Model names, prices, quality scores, and latency values in simulation are **fictional teaching profiles**, not published vendor facts. Dollar values are modeled API expenditure, not charges. Simulation demonstrates behavior and cannot establish real quality preservation or savings. See [the math and evaluation definitions](docs/MATH.md).

## Optional real responses without a paid API

The optional adapter uses an already-installed **local Ollama** model. This project does not install models, start inference services, or call paid providers automatically.

1. Install Ollama and download a model that fits your computer, using [Ollama's documentation](https://github.com/ollama/ollama).
2. Copy `.env.example` to `.env.local`, set `OLLAMA_MODEL` to your installed model name, and restart Orchestra.
3. Select **Local inference** in the request UI. Uncalibrated task quality is represented as **0 (unknown)** and initial latency as a 60-second placeholder. Set the quality floor to **0** and turn off strict latency when collecting the first calibration responses.
4. Load calibration prompts from Evaluation and run them locally. In History, rate correctness, completeness, and instruction following from 1–5. Only calibration prompts update that local model's task quality profile. Held-out evaluation ratings never train it.

To collect the 20 calibration responses sequentially:

```sh
npm run benchmark:local
# After rating calibration outputs, collect the other 20 held-out prompts:
npm run benchmark:local -- --evaluation
```

This calls the running local app, which calls your local model. It uses your machine's compute, may take several minutes, and incurs no API fee. Response times and token counts are measured. Local execution has a separate actual ledger (zero API cost), uses the real UTC month, and ignores demo opening balances. Hardware and electricity costs are excluded. A configured model is not proof the Ollama service is available: connection errors appear as failed requests, with no charge. The adapter only permits loopback endpoints and times out after 120 seconds.

With only one configured local model, live inference validates the execution path, not comparative multi-model quality. Hosted free models and trained third-party routers are extension points, not dependencies included in this version. See [Agent 2 readiness](docs/AGENT2.md).

## Optional local LiteLLM gateway

Real LiteLLM calls stay off until you opt in. Simulation, mock evaluation, and local Ollama remain available. Orchestra still selects a model in `lib/engine.ts` and sends that configured alias to the gateway. The Stage A baseline instead sends `smart-router`, and the gateway chooses a model itself. Windows setup for a private local gateway is in [the LiteLLM guide](docs/LITELLM-WINDOWS.md). Keep the app on this computer. Do not start a paid run until you intend to pay for the requests named by `EVAL_LIMIT`.

## Architecture and API

- **Agent 1** uses a pure, independently testable calculator (`lib/policy.ts`) to derive quality floor, weights, allowance, and calculation explanations from request input, company rules, and budget context. New version 1.1 snapshots preserve the effective rules; older history remains readable. No LiteLLM integration is required for this layer.
- **Agent 2** filters and ranks candidates. Hard constraints are never silently weakened. A preferred model only breaks an otherwise equal score.
- **Execution** commits a simulation atomically or reserves before a local call. Request keys prevent duplicate execution; concurrent budget writes use SQLite transactions. Interrupted local requests are marked failed after 150 seconds.
- Simulation ledgers are isolated by scenario and calendar month. Changing scenarios restores that scenario's accumulated history; it does not delete other scenarios. Editing an opening balance changes the starting balance, not prior request costs. Example opening spend is team-wide and is not assigned to individual users.

| Endpoint                     | Purpose                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspace`         | Settings, model profiles, history, defaults, local capability                                                       |
| `POST /api/workspace`        | Validate and persist the full settings object                                                                       |
| `POST /api/preview`          | `{input, settings?}` → policy and scored/excluded candidates; optional validated settings preview an unsaved budget |
| `POST /api/run`              | `{input,idempotencyKey}` → persisted response or rejection                                                          |
| `GET /api/history`           | Most recent 500 completed/rejected/failed records                                                                   |
| `GET /api/evaluate`          | 40 prompts with calibration/evaluation splits                                                                       |
| `POST /api/evaluate`         | `{input}` → independent sequential simulation for four baselines                                                    |
| `POST /api/ratings`          | `{id,correctness,completeness,instructionFollowing}` → human-rated local record                                     |
| `GET /api/export?format=csv` | Full history CSV; omit format for workspace JSON                                                                    |

The full typed contract is in `lib/types.ts`. Invalid input produces a readable 400 response. A reused request key with different input or an in-progress request returns 409. Requests with no eligible model produce a persisted `rejected` result rather than a provider call. Prompt text and responses are stored locally in SQLite and included in exports; do not publish the database or `.env.local`.

## Validate

```sh
npm test
npm run typecheck
npm run build
# Browser checks start an isolated test server; Chrome or Playwright Chromium is needed.
npm run test:browser
```

Unit/integration tests use an isolated in-memory database and a mock HTTP inference endpoint, never actual models or paid APIs. Browser tests cover request preview, run/history, settings, scenario changes, evaluation, and mocked local execution with ratings. They use an isolated server/database when started by the test script.

## Evaluation Results

Orchestra was evaluated against LiteLLM's adaptive router using
Gemma 3 models and a simulated $0.10 budget.

Across 200 requests per configuration:

- LiteLLM: 72 quality-passing responses, $0.0922 shadow cost.
- Orchestra (fixed importance): 158 passing responses, $0.0361.
- Orchestra (inferred importance): 150 passing responses, $0.0208.

Orchestra improved budget-efficient request coverage, while
automatic importance inference traded some coverage for lower cost.

See [Evaluation Results](eval/results/README.md) for methodology,
model selections, quality results, and limitations.