
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BENCHMARK_PROMPTS } from "../../lib/benchmark";
import { STAGE_A_CONFIG } from "./config";
import { LiteLLMAdapter } from "./adapters/litellm";
import { NotDiamondAdapter } from "./adapters/notdiamond";
import type {
  RouterAdapter,
  RouterRequest,
  RouterResult,
} from "./adapters/base";
import { calculateRouterMetrics } from "../shared/metrics";

const OUTPUT_DIR = "eval/results/stage-a";
const OUTPUT = `${OUTPUT_DIR}/calibration-results.json`;
const PILOT = `${OUTPUT_DIR}/pilot-results.json`;

interface SavedResults {
  results: RouterResult[];
}

async function loadResults(path: string): Promise<RouterResult[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: SavedResults = JSON.parse(raw);
    if (!Array.isArray(parsed.results)) {
      throw new Error(`Invalid results file: ${path}`);
    }
    return parsed.results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const requests: RouterRequest[] = BENCHMARK_PROMPTS
    .filter((item) => item.split === "calibration")
    .map((item) => ({
      id: item.id,
      task: item.task,
      prompt: item.prompt,
      rubric: item.rubric,
    }));

  if (requests.length !== STAGE_A_CONFIG.dataset.calibrationPrompts) {
    throw new Error("Unexpected calibration dataset size.");
  }

  const routers: RouterAdapter[] = [
    new LiteLLMAdapter(),
    new NotDiamondAdapter(),
  ];

  // Prefer existing calibration checkpoints.
  // Import pilot results only when starting a new calibration file.
  const existing = await loadResults(OUTPUT);
  const pilot = existing.length === 0
    ? await loadResults(PILOT)
    : [];

  const validIds = new Set(requests.map((request) => request.id));
  const validRouters = new Set(routers.map((router) => router.name));

  const results = [...existing, ...pilot].filter(
    (result) =>
      validIds.has(result.requestId) &&
      validRouters.has(result.router),
  );

  const completed = new Set(
    results.map((result) => `${result.requestId}:${result.router}`),
  );

  const save = async () => {
    await writeFile(
      OUTPUT,
      JSON.stringify(
        {
          experiment: STAGE_A_CONFIG.experiment,
          version: STAGE_A_CONFIG.version,
          phase: "calibration",
          updatedAt: new Date().toISOString(),
          config: STAGE_A_CONFIG,
          requests,
          results,
          summary: routers.map((router) =>
            calculateRouterMetrics(
              router.name,
              results.filter(
                (result) => result.router === router.name,
              ),
            ),
          ),
        },
        null,
        2,
      ),
    );
  };

  // Save imported pilot results before making new API calls.
  await save();

  console.log(`Calibration prompts: ${requests.length}`);
  console.log(`Existing results: ${results.length}`);
  console.log(
    `Remaining requests: ${requests.length * routers.length - completed.size}`,
  );

  for (const request of requests) {
    for (const router of routers) {
      const key = `${request.id}:${router.name}`;

      if (completed.has(key)) {
        console.log(`Skipping ${key}`);
        continue;
      }

      console.log(`\nRunning ${key}...`);

      const result = await router.route(request);

      results.push(result);
      completed.add(key);

      await save();

      console.log(
        `Success=${result.success}, ` +
        `Model=${result.selectedModel}, ` +
        `Latency=${(result.latencyMs / 1000).toFixed(2)}s, ` +
        `Cost=$${result.costUsd ?? "unknown"}`,
      );

      if (result.error) {
        console.error(`Error: ${result.error}`);
      }
    }
  }

  console.log("\n=== Calibration Summary ===");

  console.table(
    routers.map((router) =>
      calculateRouterMetrics(
        router.name,
        results.filter(
          (result) => result.router === router.name,
        ),
      ),
    ),
  );

  console.log(`\nSaved to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
