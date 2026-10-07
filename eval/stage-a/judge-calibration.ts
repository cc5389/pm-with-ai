
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { judgeResponse } from "../shared/judge";
import type { QualityJudgment } from "../shared/judge";
import type {
  RouterRequest,
  RouterResult,
} from "./adapters/base";
import { STAGE_A_CONFIG } from "./config";

const DIR = "eval/results/stage-a";
const INPUT = `${DIR}/calibration-results.json`;
const OUTPUT = `${DIR}/calibration-judgments.json`;
const PILOT = `${DIR}/pilot-judgments.json`;

interface GenerationData {
  requests: RouterRequest[];
  results: RouterResult[];
}

interface JudgmentData {
  judgments: QualityJudgment[];
}

async function loadJudgments(
  path: string,
): Promise<QualityJudgment[] | null> {
  try {
    const data: JudgmentData = JSON.parse(
      await readFile(path, "utf8"),
    );

    if (!Array.isArray(data.judgments)) {
      throw new Error(`Invalid judgment file: ${path}`);
    }

    return data.judgments;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function main() {
  await mkdir(DIR, { recursive: true });

  const generation: GenerationData = JSON.parse(
    await readFile(INPUT, "utf8"),
  );

  const expectedCount =
    STAGE_A_CONFIG.dataset.calibrationPrompts *
    STAGE_A_CONFIG.routers.length;

  if (generation.results.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} results, found ${generation.results.length}`,
    );
  }

  const saved = await loadJudgments(OUTPUT);

  // Import pilot judgments only when no calibration file exists.
  const judgments: QualityJudgment[] =
    saved ?? (await loadJudgments(PILOT)) ?? [];

  const save = async () => {
    await writeFile(
      OUTPUT,
      JSON.stringify(
        {
          experiment: STAGE_A_CONFIG.experiment,
          version: STAGE_A_CONFIG.version,
          phase: "calibration-quality",
          judgeModel: STAGE_A_CONFIG.judge.model,
          qualityThreshold:
            STAGE_A_CONFIG.judge.qualityThreshold,
          rubricVersion: STAGE_A_CONFIG.judge.rubricVersion,
          updatedAt: new Date().toISOString(),
          judgments,
        },
        null,
        2,
      ),
    );
  };

  // Preserve imported judgments before making API calls.
  await save();

  const completed = new Set(
    judgments.map(
      (item) => `${item.requestId}:${item.router}`,
    ),
  );

  console.log(`Generation results: ${generation.results.length}`);
  console.log(`Existing judgments: ${judgments.length}`);
  console.log(
    `Remaining judgments: ${
      generation.results.length - completed.size
    }`,
  );

  for (const result of generation.results) {
    const key = `${result.requestId}:${result.router}`;

    if (completed.has(key)) {
      console.log(`Skipping ${key}`);
      continue;
    }

    const request = generation.requests.find(
      (item) => item.id === result.requestId,
    );

    if (!request) {
      throw new Error(`Missing prompt for ${key}`);
    }

    console.log(`\nJudging ${key}...`);

    const judgment = await judgeResponse(
      request,
      result,
      STAGE_A_CONFIG.judge.qualityThreshold,
    );

    judgments.push(judgment);
    completed.add(key);

    await save();

    console.log(
      `Quality=${judgment.overallScore.toFixed(3)}, ` +
      `Passed=${judgment.passed}, ` +
      `Judge cost=${
        judgment.judgeCostUsd?.toFixed(6) ?? "unknown"
      }`,
    );
  }

  console.log("\n=== Calibration Quality Summary ===");

  for (const router of STAGE_A_CONFIG.routers) {
    const subset = judgments.filter(
      (item) => item.router === router,
    );

    const average =
      subset.reduce(
        (sum, item) => sum + item.overallScore,
        0,
      ) / subset.length;

    const passRate =
      subset.filter((item) => item.passed).length /
      subset.length;

    console.log(
      `${router}: average=${average.toFixed(3)}, ` +
      `pass rate=${(passRate * 100).toFixed(1)}%`,
    );
  }

  const measured = judgments.filter(
    (item) => item.judgeCostUsd != null,
  );

  const judgeCost = measured.reduce(
    (sum, item) => sum + (item.judgeCostUsd ?? 0),
    0,
  );

  console.log("\n=== Judge API Usage ===");
  console.log(`Judgments: ${judgments.length}`);
  console.log(`With cost data: ${measured.length}`);
  console.log(
    `Without cost data: ${judgments.length - measured.length}`,
  );
  console.log(`Measured judge cost: $${judgeCost.toFixed(6)}`);
  console.log(`\nSaved to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
