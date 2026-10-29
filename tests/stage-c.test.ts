import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask } from "../lib/classification";
import { stageCConfig } from "../eval/stage-c/config";
import { buildStageCWorkload } from "../eval/stage-c/workload";
import { planOrchestra } from "../eval/shared/pipelines";
import { summarizeStageC } from "../eval/stage-c/report";

for (const [prompt, difficulty, importance] of [
  ["Write a simple Python function to reverse a string", "low", "low"],
  ["Design a distributed algorithm handling concurrency", "high", "medium"],
  ["Write a casual birthday message to a friend", "low", "low"],
  ["Draft a short medical patient safety notice", "low", "high"],
  ["Help me with this", "medium", "medium"],
] as const)
  test(`classification: ${prompt}`, () => {
    const result = classifyTask(prompt);
    assert.equal(result.difficulty, difficulty);
    assert.equal(result.importance, importance);
    assert.ok(result.confidence > 0 && result.confidence <= 1);
    assert.ok(result.explanation.length > 0);
    assert.equal(result.costUsd, 0);
    assert.ok(result.latencyMs >= 0);
  });
test("Stage C budget validation and original workload", () => {
  assert.equal(stageCConfig({}).budgetUsd, 0.1);
  assert.equal(stageCConfig({ STAGE_C_BUDGET_USD: ".40" }).budgetUsd, 0.4);
  for (const raw of ["0", "-1", "NaN", "Infinity"])
    assert.throws(() => stageCConfig({ STAGE_C_BUDGET_USD: raw }));
  assert.equal(buildStageCWorkload().length, 200);
});
test("inferred importance changes actual Agent 1 policy independently of fixed label", () => {
  const item = buildStageCWorkload()[0];
  const request = {
    ...item,
    prompt: "Draft a short medical patient safety notice",
    scenarioId: "test",
    organizationState: {
      budgetUsd: 0.1,
      spentUsd: 0,
      budgetUsedFraction: 0,
      taskImportance: "low" as const,
      qualityFloor: 0.75,
    },
  };
  const fixed = planOrchestra({ ...request, importanceMode: "fixed" }).preview!;
  const inferred = planOrchestra({
    ...request,
    importanceMode: "inferred",
  }).preview!;
  assert.equal(fixed.policy.importance, "low");
  assert.equal(inferred.policy.importance, "high");
  assert.ok(inferred.policy.maxCostPerRequest > fixed.policy.maxCostPerRequest);
});
test("quality report keeps missing observations missing", () => {
  assert.deepEqual(summarizeStageC([], []).groups, {});
});

test("quality reporting separates rejection/failure and measures paired quality", async () => {
  const { MockEvaluationAdapter } =
    await import("../eval/stage-b/mock-adapter");
  const item = buildStageCWorkload()[0];
  const result = await new MockEvaluationAdapter("orchestra").execute({
    ...item,
    scenarioId: "quality-1",
    organizationState: {
      budgetUsd: 0.1,
      spentUsd: 0.05,
      budgetUsedFraction: 0.5,
      taskImportance: "high",
      qualityFloor: 0.75,
    },
  });
  result.taskCategory = "coding";
  result.policy = {
    applied: true,
    allowedModels: [],
    reason: null,
    predictedQuality: 0.9,
  };
  const rejected = structuredClone(result);
  rejected.scenarioId = "quality-2";
  rejected.generation.success = false;
  rejected.generation.outcome = "rejected";
  const failed = structuredClone(result);
  failed.scenarioId = "quality-3";
  failed.generation.success = false;
  failed.generation.outcome = "failed";
  const records = [result, rejected, failed].map((result, sequenceIndex) => ({
    variant: "orchestra-fixed",
    sequenceIndex,
    result,
  }));
  const report = summarizeStageC(records, [
    { scenarioId: "quality-1", overallScore: 0.5, passed: false },
  ]);
  const group = report.groups["orchestra-fixed/all"];
  assert.equal(group.rejected, 1);
  assert.equal(group.failed, 1);
  assert.equal(group.successfulGenerations, 1);
  assert.equal(group.generationSuccessRate, 1 / 3);
  assert.equal(group.overallSuccessfulServiceRate, 0);
  const passing = summarizeStageC(records, [
    { scenarioId: "quality-1", overallScore: 0.9, passed: true },
  ]).groups["orchestra-fixed/all"];
  assert.equal(passing.observedPassRate, 1);
  assert.equal(passing.overallSuccessfulServiceRate, 1 / 3);
  assert.equal(group.judged, 1);
  assert.equal(group.observedPassRate, 0);
  assert.equal(group.qualityFloorViolationRate, 1);
  assert.equal(group.meanPredictedQuality, 0.9);
  assert.equal(group.meanObservedQuality, 0.5);
  assert.ok(report.groups["orchestra-fixed/category:coding"]);
  assert.equal(result.policy.predictedQuality, 0.9);
});
