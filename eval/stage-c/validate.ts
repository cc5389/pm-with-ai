import { readCheckpoint } from "../shared/checkpoint-io";
import { executionMode } from "../shared/run-mode";
import { classifyTask } from "../../lib/classification";
import { stageCConfig, stageCPath, VARIANTS } from "./config";
import { restoreCheckpoint } from "./checkpoint";
import type { ReportRecord } from "./report";
import { buildStageCWorkload } from "./workload";

async function main() {
  const saved = await readCheckpoint<{
    budgetUsd: number;
    workloadSize: number;
    records: ReportRecord[];
  }>(stageCPath(executionMode()));
  if (
    !saved ||
    saved.budgetUsd !== stageCConfig().budgetUsd ||
    saved.workloadSize < 1 ||
    saved.workloadSize > 200
  )
    throw new Error("Invalid Stage C configuration");
  const workload = buildStageCWorkload().slice(0, saved.workloadSize);
  for (const variant of VARIANTS.filter(
    (v) => stageCConfig().variant === "all" || stageCConfig().variant === v,
  )) {
    const records = saved.records
      .filter((r) => r.variant === variant)
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    if (records.length !== workload.length)
      throw new Error(`${variant}: incomplete records`);
    restoreCheckpoint(
      variant === "baseline" ? "baseline" : "orchestra",
      records,
      workload.map((item) => ({
        ...item,
        taskImportance:
          variant === "orchestra-inferred"
            ? classifyTask(item.prompt).importance
            : item.taskImportance,
      })),
      saved.budgetUsd,
      variant,
    );
    console.log(`PASS ${variant}: ${records.length} consistent requests`);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
