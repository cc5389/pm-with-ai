# Agent 2: what is built and what remains

## Available now

The deterministic router compares eligible candidates against Agent 1's policy. It needs no trained router, API key, or payment. A simulation can demonstrate model changes as forecast and available funds change. Every candidate exposes its estimated cost, quality, latency, score, and exclusion reasons. Optional local execution produces real text and observed timing using one configured Ollama model.

## What is needed for a defensible multi-model experiment

- At least two executable models, locally installed or accessible through a verified free service, with sufficient capacity/rate limits for the evaluation workload.
- A consistent task-specific rubric and rated **calibration** responses for each model. The 40-prompt seed dataset contains 20 calibration and 20 held-out evaluation prompts; expand before drawing strong statistical conclusions.
- Measured latency at a stated output limit and hardware/load, plus actual token usage. Latency expectations cannot guarantee a deadline.
- For paid comparisons later: verified model identifiers, current provider pricing, billing usage, and an adapter that reserves a conservative maximum before dispatch and reconciles actual cost afterward. Fictional sample prices must not enter real billing.
- A controlled workload: compare the same held-out requests, constraints, dates, and budgets. Report completion and rejection rates along with quality and spending so skipped requests are not counted as savings.

The current benchmark table is explicitly **simulated**. Human ratings on local held-out responses provide real individual results in History/export, but the app does not yet run a learned multi-model router or infer performance claims from those ratings.

## Integration options researched

- [RouteLLM](https://github.com/lm-sys/RouteLLM) is open-source and can route a strong/weak model pair. Router software availability does not make hosted model inference free.
- [Not Diamond's modelSelect API](https://docs.notdiamond.ai/reference/token_model_select_v2_modelrouter_modelselect_post) recommends a candidate and leaves execution to the caller. It is optional and requires account access; cost/quality and latency controls are not interchangeable.
- [OpenRouter](https://openrouter.ai/docs/quickstart) can execute an explicitly selected model. An external gateway's automatic routing would introduce a second model-selection step. Availability and limits of free endpoints must be checked before adopting one.
- [LiteLLM](https://docs.litellm.ai/docs/proxy/users) already provides budget features. This project treats forecast-aware, explainable policy as a testable hypothesis, not a claim that competitors have no budgets.

For this no-funded-API deliverable, none of these external services is required or contacted by the app.
