
import { mkdir, writeFile } from "node:fs/promises";
import { BENCHMARK_PROMPTS } from "../../lib/benchmark";
import { LiteLLMAdapter } from "./adapters/litellm";
import { NotDiamondAdapter } from "./adapters/notdiamond";
import type {
  RouterAdapter,
  RouterRequest,
  RouterResult,
} from "./adapters/base";
import { calculateRouterMetrics } from "../shared/metrics";

const OUTPUT_DIR = "eval/results/stage-a";

async function main() {
  // Use one calibration prompt per task.
  // Held-out evaluation prompts are not touched.
  const tasks = ["coding", "analysis", "writing", "qa"];

  const requests: RouterRequest[] = tasks.map((task) => {
    const prompt = BENCHMARK_PROMPTS.find(
      (item) => item.task === task && item.split === "calibration",
    );

    if (!prompt) {
      throw new Error(`No calibration prompt for task: ${task}`);
    }

    return {
      id: prompt.id,
      task: prompt.task,
      prompt: prompt.prompt,
      rubric: prompt.rubric,
    };
  });

  const routers: RouterAdapter[] = [
    new LiteLLMAdapter(),
    new NotDiamondAdapter(),
  ];

  const results: RouterResult[] = [];

  console.log(`Running ${requests.length} prompts on ${routers.length} routers`);

  for (const request of requests) {
    for (const router of routers) {
      console.log(`\nRunning ${request.id} with ${router.name}...`);

      const result = await router.route(request);
      results.push(result);

      console.log(`Success: ${result.success}`);
      console.log(`Model: ${result.selectedModel}`);
      console.log(`Latency: ${(result.latencyMs / 1000).toFixed(2)}s`);
      console.log(`Cost: $${result.costUsd ?? "unknown"}`);

      if (result.error) {
        console.error(`Error: ${result.error}`);
      }
    }
  }

  const summary = routers.map((router) =>
    calculateRouterMetrics(
      router.name,
      results.filter((result) => result.router === router.name),
    ),
  );

  await mkdir(OUTPUT_DIR, { recursive: true });

  await writeFile(
    `${OUTPUT_DIR}/pilot-results.json`,
    JSON.stringify(
      {
        experiment: "stage-a-pilot",
        timestamp: new Date().toISOString(),
        requests,
        results,
        summary,
      },
      null,
      2,
    ),
  );

  console.log("\n=== Stage A Pilot Summary ===");
  console.table(summary);
  console.log(`\nSaved to ${OUTPUT_DIR}/pilot-results.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
