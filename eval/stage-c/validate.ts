
import { readFile } from "node:fs/promises";
import { buildStageCWorkload } from "./workload";
import type {
  EvaluationResult,
  EvaluationSystem,
} from "../shared/pipeline";

const INPUT = "eval/results/stage-c/mock-results.json";
const EPSILON = 1e-8;

interface StageCRecord {
  sequenceIndex: number;
  result: EvaluationResult;
}

interface SavedResults {
  mode: string;
  budgetUsd: number;
  workloadSize: number;
  records: StageCRecord[];
}

function approximatelyEqual(a: number, b: number): boolean {
  return Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= EPSILON;
}

async function main() {
  const saved: SavedResults = JSON.parse(
    await readFile(INPUT, "utf8"),
  );

  if (
    saved.mode !== "mock" ||
    !Array.isArray(saved.records) ||
    !Number.isFinite(saved.budgetUsd) ||
    saved.budgetUsd <= 0
  ) {
    throw new Error("Invalid Stage C results file.");
  }

  const workload = buildStageCWorkload();

  if (saved.workloadSize !== workload.length) {
    throw new Error("Workload size mismatch.");
  }

  const systems: EvaluationSystem[] = [
    "baseline",
    "orchestra",
  ];

  const errors: string[] = [];

  for (const system of systems) {
    const records = saved.records
      .filter((record) => record.result.system === system)
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);

    if (records.length !== workload.length) {
      errors.push(
        `${system}: expected ${workload.length} records, found ${records.length}`,
      );
    }

    let expectedSpent = 0;

    for (let i = 0; i < records.length; i++) {
      const { sequenceIndex, result } = records[i];
      const before = result.stateBefore;
      const after = result.stateAfter;
      const cost = result.generation.costUsd;

      if (sequenceIndex !== i) {
        errors.push(`${system}: incorrect sequence at ${i}`);
      }

      if (
        i >= workload.length ||
        result.requestId !== workload[i].id
      ) {
        errors.push(`${system}: incorrect request ID at ${i}`);
      }

      if (
        result.scenarioId !== `stage-c-${system}-${i + 1}`
      ) {
        errors.push(`${system}: incorrect scenario ID at ${i}`);
      }

      if (!approximatelyEqual(before.budgetUsd, saved.budgetUsd)) {
        errors.push(`${system}: budget total mismatch at ${i}`);
      }

      if (!approximatelyEqual(before.spentUsd, expectedSpent)) {
        errors.push(`${system}: stateBefore mismatch at ${i}`);
      }

      if (
        !approximatelyEqual(
          before.budgetUsedFraction,
          expectedSpent / saved.budgetUsd,
        )
      ) {
        errors.push(`${system}: before utilization mismatch at ${i}`);
      }

      if (
        cost === null ||
        !Number.isFinite(cost) ||
        cost < 0
      ) {
        errors.push(`${system}: invalid cost at ${i}`);
        continue;
      }

      expectedSpent += cost;

      if (after === null) {
        errors.push(`${system}: missing stateAfter at ${i}`);
        continue;
      }

      if (!approximatelyEqual(after.spentUsd, expectedSpent)) {
        errors.push(`${system}: stateAfter mismatch at ${i}`);
      }

      if (
        !approximatelyEqual(
          after.budgetUsedFraction,
          expectedSpent / saved.budgetUsd,
        )
      ) {
        errors.push(`${system}: after utilization mismatch at ${i}`);
      }
    }

    console.log(
      `${system}: ${records.length} requests, ` +
      `$${expectedSpent.toFixed(6)} spent`,
    );
  }

  if (errors.length > 0) {
    console.error("Validation failures:");
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log("PASS: Stage C budget trajectories are consistent.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
