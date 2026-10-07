
import { readFile, writeFile, access } from "node:fs/promises";
import type { QualityJudgment } from "../shared/judge";
import { judgeResponse } from "../shared/judge";
import type {
  RouterRequest,
  RouterResult,
} from "./adapters/base";

const INPUT = "eval/results/stage-a/pilot-results.json";
const OUTPUT = "eval/results/stage-a/pilot-judgments.json";

interface PilotData {
  requests: RouterRequest[];
  results: RouterResult[];
}

async function main() {
  const raw = await readFile(INPUT, "utf8");
  const pilot: PilotData = JSON.parse(raw);

  let judgments: QualityJudgment[] = [];
  
  try {
    await access(OUTPUT);
  
    const existing = JSON.parse(
      await readFile(OUTPUT, "utf8"),
    );
  
    judgments = existing.judgments ?? [];
  
    console.log(
      `Resuming with ${judgments.length} saved judgments.`,
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  console.log(
    `Evaluating ${pilot.results.length} saved responses...`,
  );

  for (const result of pilot.results) {
    const alreadyJudged = judgments.some(
        (item) =>
          item.requestId === result.requestId &&
          item.router === result.router,
      );
      
      if (alreadyJudged) {
        console.log(
          `Skipping ${result.requestId} (${result.router}): already judged.`,
        );
        continue;
      }
    const request = pilot.requests.find(
      (item) => item.id === result.requestId,
    );

    if (!request) {
      throw new Error(
        `Missing request for result: ${result.requestId}`,
      );
    }

    console.log(
      `\nJudging ${result.requestId} (${result.router})...`,
    );

    const judgment = await judgeResponse(request, result);
    judgments.push(judgment);

    await writeFile(
        OUTPUT,
        JSON.stringify(
          {
            experiment: "stage-a-pilot-quality",
            judgeModel: "gpt-4.1-mini-2025-04-14",
            qualityThreshold: 0.75,
            timestamp: new Date().toISOString(),
            judgments,
          },
          null,
          2,
        ),
      );

    console.log(
      `Quality: ${judgment.overallScore.toFixed(3)}`,
    );
    console.log(`Passed: ${judgment.passed}`);
    console.log(`Reason: ${judgment.reasoning}`);
  }

  await writeFile(
    OUTPUT,
    JSON.stringify(
      {
        experiment: "stage-a-pilot-quality",
        judgeModel: "gpt-4.1-mini-2025-04-14",
        qualityThreshold: 0.75,
        timestamp: new Date().toISOString(),
        judgments,
      },
      null,
      2,
    ),
  );

  console.log("\n=== Quality Summary ===");

  for (const router of ["litellm", "notdiamond"]) {
    const subset = judgments.filter(
      (item) => item.router === router,
    );

    const averageQuality =
      subset.reduce(
        (sum, item) => sum + item.overallScore,
        0,
      ) / subset.length;

    const passRate =
      subset.filter((item) => item.passed).length /
      subset.length;

    console.log(
      `${router}: avg quality=${averageQuality.toFixed(3)}, ` +
      `pass rate=${(passRate * 100).toFixed(1)}%`,
    );
  }

  
  const measuredJudgments = judgments.filter(
    (item) => item.judgeCostUsd != null,
  );
  
  const totalJudgeCost = measuredJudgments.reduce(
    (sum, item) => sum + (item.judgeCostUsd ?? 0),
    0,
  );
  
  const totalJudgeInputTokens = measuredJudgments.reduce(
    (sum, item) => sum + (item.judgeInputTokens ?? 0),
    0,
  );
  
  const totalJudgeOutputTokens = measuredJudgments.reduce(
    (sum, item) => sum + (item.judgeOutputTokens ?? 0),
    0,
  );
  
  console.log("\n=== Judge API Usage ===");
  console.log(`Judgments: ${judgments.length}`);
  console.log(`With cost data: ${measuredJudgments.length}`);
  console.log(`Without cost data: ${judgments.length - measuredJudgments.length}`);
  console.log(`Measured judge cost: $${totalJudgeCost.toFixed(6)}`);
  console.log(`Measured input tokens: ${totalJudgeInputTokens}`);
  console.log(`Measured output tokens: ${totalJudgeOutputTokens}`);
  
  console.log(`\nSaved to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
