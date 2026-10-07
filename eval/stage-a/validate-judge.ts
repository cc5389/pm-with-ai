
import { judgeResponse } from "../shared/judge";
import type {
  RouterRequest,
  RouterResult,
} from "./adapters/base";

const request: RouterRequest = {
  id: "judge-validation-01",
  task: "coding",
  prompt:
    "Write a Python function that returns the second distinct largest integer in a list. Explain empty and duplicate-only cases.",
  rubric: "Distinctness, boundary cases, valid Python.",
};

const examples = [
  {
    label: "strong",
    response: `def second_largest(nums):
    unique = sorted(set(nums), reverse=True)
    return unique[1] if len(unique) >= 2 else None

Returns None for empty lists or lists with fewer than
two distinct values. Duplicates do not count separately.`,
  },
  {
    label: "partial",
    response: `def second_largest(nums):
    return sorted(nums)[-2]

This returns the second largest value.`,
  },
  {
    label: "incorrect",
    response:
      "The second largest number is always the last item in the list.",
  },
];

async function main() {
  for (const example of examples) {
    const result: RouterResult = {
      router: "litellm",
      requestId: request.id,
      success: true,
      selectedModel: null,
      response: example.response,
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      error: null,
    };

    const judgment = await judgeResponse(request, result);

    console.log(`\n=== ${example.label.toUpperCase()} ===`);
    console.log(`Quality: ${judgment.overallScore.toFixed(3)}`);
    console.log(`Passed: ${judgment.passed}`);
    console.log(
      `Scores: correctness=${judgment.correctness}, ` +
      `completeness=${judgment.completeness}, ` +
      `instructionFollowing=${judgment.instructionFollowing}`,
    );
    console.log(`Reason: ${judgment.reasoning}`);
    console.log(
      `Judge cost: $${judgment.judgeCostUsd?.toFixed(6) ?? "unknown"}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
