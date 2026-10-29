import { classifyTask } from "../lib/classification";
import { POST as previewPOST } from "../app/api/preview/route";
import { POST as runPOST } from "../app/api/run/route";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { DEFAULT_INPUT, DEFAULT_SETTINGS } from "../lib/catalog";
import { BENCHMARK_PROMPTS } from "../lib/benchmark";
import {
  db,
  budgetContext,
  saveSettings,
  getSettings,
  history,
  transaction,
  reserve,
  scopeOf,
  recoverInterrupted,
} from "../lib/db";
import {
  previewRequest,
  runRequest,
  rateRecord,
  workspace,
} from "../lib/service";
import { inputSchema, settingsSchema } from "../lib/validation";
import { generateLocal } from "../lib/local";
process.env.ORCHESTRA_DB_PATH = ":memory:";
beforeEach(() => {
  db().exec("DELETE FROM requests");
  saveSettings(structuredClone(DEFAULT_SETTINGS));
  delete process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_BASE_URL;
});
const input = () => ({
  ...structuredClone(DEFAULT_INPUT),
  qualityFloor: 0,
  maxRequestCost: 1,
});

test("preview does not write history or spend", () => {
  const request = input(),
    settings = getSettings(),
    before = budgetContext(settings, request);
  assert.ok(previewRequest(request).selected);
  assert.deepEqual(budgetContext(settings, request), before);
  assert.equal(history().length, 0);
});
test("simulation executes once per idempotency key and never records actual charges", async () => {
  const request = input(),
    key = randomUUID(),
    first = await runRequest(request, key),
    second = await runRequest(request, key);
  assert.equal(first.status, "completed");
  assert.equal(first.id, second.id);
  assert.equal(history().length, 1);
  assert.equal(first.actualCost, 0);
  assert.match(first.response, /SIMULATED/);
  assert.equal(first.measuredLatencyMs, null);
  assert.ok(first.simulatedCost > 0);
  assert.ok(
    Math.abs(
      budgetContext(getSettings(), request).spent -
        getSettings().openingSpend -
        first.simulatedCost,
    ) < 1e-9,
  );
  await assert.rejects(
    runRequest({ ...request, prompt: "Different request" }, key),
    /different input/,
  );
});
test("concurrent simulation requests serialize budget consumption", async () => {
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    scenario: "custom" as const,
    monthlyBudget: 0.0008,
    openingSpend: 0,
    monthlyRequests: 1,
    simulatedDate: "2026-10-31",
  };
  saveSettings(settings);
  const request = {
    ...input(),
    prompt: "Hi",
    outputTokens: 32,
    importance: "high" as const,
  };
  const results = await Promise.all(
    Array.from({ length: 20 }, () => runRequest(request, randomUUID())),
  );
  const spent = results.reduce((s, r) => s + r.simulatedCost, 0);
  assert.ok(spent <= settings.monthlyBudget + 1e-12);
  assert.ok(results.some((r) => r.status === "rejected"));
});
test("pending reservations are included in team and user availability", () => {
  const request = input(),
    settings = getSettings(),
    preview = previewRequest(request);
  assert.ok(preview.selected);
  transaction(() => reserve(randomUUID(), request, settings, preview));
  const context = budgetContext(settings, request);
  assert.equal(context.reserved, preview.selected.estimatedCost);
  assert.equal(context.userReserved, preview.selected.estimatedCost);
  const next = previewRequest(request);
  assert.ok(next.policy.budget.remaining < preview.policy.budget.remaining);
});
test("month rollover and demo scenarios isolate ledgers without deleting history", async () => {
  const request = input();
  await runRequest(request, randomUUID());
  const settings = getSettings();
  saveSettings({ ...settings, simulatedDate: "2026-11-01", openingSpend: 0 });
  assert.equal(budgetContext(getSettings(), request).spent, 0);
  assert.equal(history().length, 1);
  assert.notEqual(
    scopeOf(settings, "simulation"),
    scopeOf({ ...settings, scenario: "tight" }, "simulation"),
  );
});
test("rejected requests and simulation ratings cannot affect measured quality", async () => {
  const request = {
    ...input(),
    blockedModels: workspace().models.map((m) => m.id),
  };
  const record = await runRequest(request, randomUUID());
  assert.equal(record.status, "rejected");
  assert.equal(record.simulatedCost, 0);
  assert.throws(() => rateRecord(record.id, 5, 5, 5), /Only completed real/);
});
test("invalid inputs fail at API schema boundary", () => {
  assert.equal(
    inputSchema.safeParse({
      ...input(),
      weights: { quality: 0, cost: 0, latency: 0 },
    }).success,
    false,
  );
  assert.equal(
    inputSchema.safeParse({ ...input(), qualityFloor: 1.1 }).success,
    false,
  );
  assert.equal(
    inputSchema.safeParse({ ...input(), prompt: "  " }).success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      simulatedDate: "2026-02-30",
    }).success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      users: [DEFAULT_SETTINGS.users[0], DEFAULT_SETTINGS.users[0]],
    }).success,
    false,
  );
});
test("unknown users and unconfigured local requests are rejected", () => {
  assert.throws(
    () => previewRequest({ ...input(), userId: "missing" }),
    /Choose a user/,
  );
  assert.throws(
    () => previewRequest({ ...input(), mode: "local" }),
    /not configured/,
  );
});
test("local responses record real timing, zero API cost, and calibrate only on calibration prompts", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          response: "A real adapter test response",
          done: true,
          prompt_eval_count: 20,
          eval_count: 8,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  process.env.OLLAMA_MODEL = "fixture-model";
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${addr.port}`;
  try {
    const calibration = BENCHMARK_PROMPTS.find(
      (p) => p.split === "calibration",
    )!;
    const request = {
      ...input(),
      prompt: calibration.prompt,
      task: calibration.task,
      mode: "local" as const,
      strictLatency: false,
      localOnly: true,
    };
    const record = await runRequest(request, randomUUID());
    assert.equal(record.status, "completed");
    assert.equal(record.actualCost, 0);
    assert.equal(record.simulatedCost, 0);
    assert.ok(record.measuredLatencyMs !== null);
    assert.equal(record.simulatedLatency, null);
    rateRecord(record.id, 5, 4, 3);
    const profile = workspace().models.find((m) => m.local)!;
    assert.equal(profile.quality[calibration.task], 0.75);
    assert.equal(profile.sampleCount, 1);
    const calibratedLatency = workspace().models.find((m) => m.local)!.latency[
      calibration.task
    ];
    const held = BENCHMARK_PROMPTS.find(
      (p) => p.split === "evaluation" && p.task === calibration.task,
    )!;
    const evaluation = await runRequest(
      { ...request, prompt: held.prompt },
      randomUUID(),
    );
    rateRecord(evaluation.id, 1, 1, 1);
    assert.equal(
      workspace().models.find((m) => m.local)!.quality[calibration.task],
      0.75,
    );
    assert.equal(
      workspace().models.find((m) => m.local)!.latency[calibration.task],
      calibratedLatency,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("local connection errors preserve a failed record without spend", async () => {
  process.env.OLLAMA_MODEL = "fixture-model";
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
  const request = { ...input(), mode: "local" as const, strictLatency: false };
  const record = await runRequest(request, randomUUID());
  assert.equal(record.status, "failed");
  assert.ok(record.error);
  assert.equal(record.actualCost, 0);
  assert.equal(record.simulatedCost, 0);
});
test("local adapter refuses remote URLs", async () => {
  process.env.OLLAMA_MODEL = "fixture-model";
  process.env.OLLAMA_BASE_URL = "https://example.com";
  await assert.rejects(generateLocal(input()), /only connects to a local/);
});

test("interrupted requests release reservations and become visible failures", () => {
  const request = input(),
    preview = previewRequest(request),
    settings = getSettings();
  const meta = transaction(() =>
    reserve(randomUUID(), request, settings, preview),
  );
  db()
    .prepare("UPDATE requests SET created_at=? WHERE id=?")
    .run(new Date(Date.now() - 200000).toISOString(), meta.id);
  recoverInterrupted();
  const records = history();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "failed");
  assert.match(records[0].error!, /interrupted/);
  assert.equal(budgetContext(settings, request).reserved, 0);
});

test("draft budget previews calculate without persisting settings or spend", () => {
  const saved = getSettings(),
    request = input();
  const draft = {
    ...saved,
    monthlyBudget: 2000,
    openingSpend: 500,
    simulatedDate: "2026-10-16",
    scenario: "custom" as const,
  };
  const preview = previewRequest(request, draft);
  assert.equal(preview.policy.budget.monthlyBudget, 2000);
  assert.equal(preview.policy.budget.spent, 500);
  assert.equal(preview.policy.budget.remaining, 1500);
  assert.deepEqual(getSettings(), saved);
  assert.equal(history().length, 0);
});

test("demo defaults to automatic without changing legacy request defaults", () => {
  assert.equal(workspace().defaultInput.importanceMode, "inferred");
  assert.equal(inputSchema.parse(input()).importanceMode, "fixed");
  assert.equal(
    inputSchema.safeParse({ ...input(), importanceMode: "automatic" }).success,
    false,
  );
});

test("automatic preview reuses Stage C classification and the fixed routing policy", () => {
  for (const prompt of [
    "Write a short birthday poem for a friend",
    "Review a distributed production security incident",
    "Explain the topic",
  ]) {
    const request = inputSchema.parse({
      ...input(),
      prompt,
      importance: "low",
      importanceMode: "inferred",
    });
    const preview = previewRequest(request);
    const classification = classifyTask(prompt);
    assert.equal(preview.classification?.importance, classification.importance);
    assert.equal(preview.classification?.difficulty, classification.difficulty);
    assert.equal(
      preview.classification?.explanation,
      classification.explanation,
    );
    assert.equal(preview.classification?.costUsd, 0);
    const fixed = previewRequest({
      ...request,
      importanceMode: "fixed",
      importance: classification.importance,
    });
    assert.deepEqual(preview.policy, fixed.policy);
    assert.deepEqual(preview.candidates, fixed.candidates);
    assert.deepEqual(preview.selected, fixed.selected);
  }
});

test("manual override preserves the supplied importance for a high-stakes prompt", async () => {
  const request = inputSchema.parse({
    ...input(),
    prompt: "Review a production security incident",
    importance: "low",
    importanceMode: "fixed",
  });
  const preview = previewRequest(request);
  const run = await runRequest(request, randomUUID());
  assert.equal(preview.classification, undefined);
  assert.equal(preview.policy.importance, "low");
  assert.deepEqual(run.preview.policy, preview.policy);
  assert.equal(run.input.importance, "low");
});

test("preview and run HTTP routes preserve inferred classification and routing", async () => {
  const request = {
    ...input(),
    prompt: "Review a distributed production security incident",
    importance: "low",
    importanceMode: "inferred",
  };
  const post = (url: string, payload: unknown) =>
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  const previewResponse = await previewPOST(
    post("/api/preview", { input: request }),
  );
  const runResponse = await runPOST(
    post("/api/run", { input: request, idempotencyKey: randomUUID() }),
  );
  assert.equal(previewResponse.status, 200);
  assert.equal(runResponse.status, 200);
  const preview = await previewResponse.json();
  const run = await runResponse.json();
  assert.equal(preview.policy.importance, "high");
  assert.equal(run.input.importance, "high");
  assert.deepEqual(run.preview.policy, preview.policy);
  assert.deepEqual(run.preview.candidates, preview.candidates);
  assert.equal(
    run.preview.classification.explanation,
    preview.classification.explanation,
  );
  assert.equal(run.status, "completed");
});

for (const constraint of [
  { maxRequestCost: 0 },
  { qualityFloor: 1 },
  { maxRequestCost: 0, qualityFloor: 1 },
]) {
  test(`rejections explain constraints without relaxing policy: ${JSON.stringify(constraint)}`, async () => {
    const request = inputSchema.parse({
      ...input(),
      ...constraint,
      prompt: "Review production security",
      importanceMode: "inferred",
    });
    const preview = previewRequest(request);
    const key = randomUUID();
    const run = await runRequest(request, key);
    assert.equal(preview.selected, null);
    assert.equal(run.status, "rejected");
    assert.equal(run.error, preview.rejectionReason);
    assert.match(run.error!, /high importance/);
    if (constraint.maxRequestCost === 0)
      assert.match(run.error!, /cost exceeds this request's allowance/);
    if (constraint.qualityFloor === 1)
      assert.match(run.error!, /quality is below the required floor/);
    assert.equal(run.simulatedCost, 0);
    assert.equal(run.actualCost, 0);
    assert.equal(budgetContext(getSettings(), request).reserved, 0);
    assert.equal((await runRequest(request, key)).id, run.id);
  });
}
