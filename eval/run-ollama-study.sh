#!/usr/bin/env bash
# Runs the full local study on the Ollama pool: calibration, Stage B, Stage C,
# their judges, and the metrics report. Every step resumes from its checkpoint,
# so rerun this script after an interruption. Needs Ollama, the LiteLLM gateway,
# and .env.local as described in docs/OLLAMA.md. Nothing is billed.
set -euo pipefail
cd "$(dirname "$0")/.."

run() {
  echo
  echo "=== $1"
  shift
  node --env-file=.env.local --import tsx "$@"
}

export EVAL_EXECUTION=real EVAL_MODE=real
run "Calibration" eval/calibration/run.ts
run "Stage B generation" eval/stage-b/run.ts
run "Stage B constraints" eval/stage-b/evaluate.ts
run "Stage B judging" eval/stage-b/judge.ts
run "Stage C generation" eval/stage-c/run.ts
run "Stage C validation" eval/stage-c/validate.ts
run "Stage C judging" eval/stage-c/judge.ts
run "Metrics report" eval/report.ts
