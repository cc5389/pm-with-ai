import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INPUT, DEFAULT_SETTINGS } from "../lib/catalog";
import {
  db,
  getSettings,
  history,
  recoverInterrupted,
  reserve,
  saveSettings,
  transaction,
} from "../lib/db";
import { previewRequest, runRequest, workspace } from "../lib/service";
import { completeLiteLLM } from "../eval/shared/litellm-client";
import {
  MODEL_POOLS,
  describeReturnedModel,
  litellmProfiles,
  pricingModelId,
  type PoolCalibration,
} from "../eval/shared/model-pool";
import { calculateGenerationCost } from "../eval/shared/pricing";
import { assertPaidRunIsExplicit, resultsPath } from "../eval/shared/run-mode";
import { judgeConfig, parseJudgeContent } from "../eval/shared/judge";
import type { RequestInput } from "../lib/types";

process.env.ORCHESTRA_DB_PATH = ":memory:";
const ollama = MODEL_POOLS.ollama;
const ENV_KEYS = [
  "ORCHESTRA_POOL",
  "LITELLM_MASTER_KEY",
  "LITELLM_URL",
  "ORCHESTRA_CALIBRATION_PATH",
] as const;
const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  db().exec("DELETE FROM requests");
  saveSettings(structuredClone(DEFAULT_SETTINGS));
  for (const key of ENV_KEYS) delete process.env[key];
  // Never read a real calibration file from the working tree.
  process.env.ORCHESTRA_CALIBRATION_PATH = join(
    mkdtempSync(join(tmpdir(), "orchestra-")),
    "none.json",
  );
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

const gatewayInput = (fields: Partial<RequestInput> = {}): RequestInput => ({
  ...structuredClone(DEFAULT_INPUT),
  qualityFloor: 0,
  maxRequestCost: 1,
  outputTokens: 256,
  mode: "gateway",
  ...fields,
});

async function body(req: IncomingMessage): Promise<{ model: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** A fake LiteLLM gateway that answers as the requested Ollama model. */
async function fakeGateway(
  respond: (model: string) => {
    returned: string;
    costHeader?: string;
  } = (model) => ({
    returned: `ollama_chat/${ollama.models.find((m) => m.alias === model)!.providerModel}`,
  }),
) {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    const { model } = await body(req);
    calls.push(model);
    const { returned, costHeader } = respond(model);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-litellm-model-name", returned);
    if (costHeader !== undefined)
      res.setHeader("x-litellm-response-cost", costHeader);
    res.end(
      JSON.stringify({
        choices: [{ message: { content: `answer from ${model}` } }],
        usage: { prompt_tokens: 40, completion_tokens: 120 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  process.env.ORCHESTRA_POOL = "ollama";
  process.env.LITELLM_MASTER_KEY = "test-gateway-master-key";
  process.env.LITELLM_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  return {
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the Ollama pool shadow-prices each tier like the gpt-4.1 tier of the same size", () => {
  const tiers: Record<number, string> = {
    1: "gpt-4.1-nano-2025-04-14",
    2: "gpt-4.1-mini-2025-04-14",
    3: "gpt-4.1-2025-04-14",
  };
  for (const model of ollama.models) {
    assert.equal(
      calculateGenerationCost(model.providerModel, 100, 200),
      calculateGenerationCost(tiers[model.qualityTier], 100, 200),
    );
  }
  assert.equal(pricingModelId("ollama_chat/gemma3:4b", ollama), "gemma3:4b");
  assert.deepEqual(
    describeReturnedModel("gemma3-1b", "ollama_chat/gemma3:1b", ollama),
    { selectedModel: "gemma3-1b", mismatch: false },
  );
  assert.equal(
    describeReturnedModel("gemma3-1b", "ollama_chat/gemma3:12b", ollama)
      .mismatch,
    true,
  );
});

test("calibration files replace the shared estimate with measured quality", () => {
  const uncalibrated = litellmProfiles(ollama, null);
  assert.ok(uncalibrated.every((p) => p.quality.qa === 0.75 && p.gateway));
  assert.ok(uncalibrated.every((p) => p.source === "illustrative"));

  const calibration: PoolCalibration = {
    pool: "ollama",
    judgeModel: "qwen3.5:9b",
    updatedAt: "2026-10-21T00:00:00.000Z",
    models: {
      "gemma3-1b": {
        quality: { qa: 0.5 },
        latencySeconds: { qa: 0.4 },
        samples: { qa: 5 },
      },
    },
  };
  const profiles = litellmProfiles(ollama, calibration);
  const small = profiles.find((p) => p.id === "gemma3-1b")!;
  assert.equal(small.quality.qa, 0.5);
  assert.equal(small.latency.qa, 0.4);
  assert.equal(small.source, "measured");
  assert.equal(small.quality.coding, 0.75);
  assert.equal(
    profiles.find((p) => p.id === "gemma3-12b")!.source,
    "illustrative",
  );
});

test("Ollama results get their own files and need no paid-run limit", () => {
  assert.equal(
    resultsPath("stage-b", "real", ollama),
    "eval/results/stage-b/real-ollama-results.json",
  );
  assert.equal(
    resultsPath("stage-c", "real", MODEL_POOLS.openai, "judgments"),
    "eval/results/stage-c/real-judgments.json",
  );
  assert.equal(
    resultsPath("stage-b", "mock", ollama),
    "eval/results/stage-b/mock-results.json",
  );
  assert.doesNotThrow(() => assertPaidRunIsExplicit("real", null, ollama));
  assert.throws(
    () => assertPaidRunIsExplicit("real", null, MODEL_POOLS.openai),
    /opt-in/,
  );
});

test("a shadow-priced pool ignores a zero cost header and charges the price table", async () => {
  const gateway = await fakeGateway((model) => ({
    returned: `ollama_chat/gemma3:${model.split("-")[1]}`,
    costHeader: "0",
  }));
  try {
    const call = await completeLiteLLM({
      model: "gemma3-4b",
      prompt: "Hi",
      maxTokens: 256,
    });
    assert.equal(call.costBasis, "estimated");
    assert.equal(call.costUsd, calculateGenerationCost("gemma3:4b", 40, 120));
  } finally {
    await gateway.close();
  }
});

test("the local judge strips thinking and reads JSON from prose", () => {
  assert.deepEqual(
    parseJudgeContent(
      '<think>weighing it</think>Here: {"correctness":5,"completeness":4,"instructionFollowing":5,"reasoning":"ok"}',
    ),
    {
      correctness: 5,
      completeness: 4,
      instructionFollowing: 5,
      reasoning: "ok",
    },
  );
  assert.throws(
    () =>
      parseJudgeContent(
        '{"correctness":7,"completeness":4,"instructionFollowing":5,"reasoning":"x"}',
      ),
    /1 to 5/,
  );
  const local = judgeConfig({
    JUDGE_BASE_URL: "http://127.0.0.1:11434/v1",
    JUDGE_MODEL: "qwen3.5:9b",
  });
  assert.equal(local.local, true);
  assert.equal(local.model, "qwen3.5:9b");
  assert.equal(local.apiKey, "ollama");
  assert.equal(judgeConfig({}).model, "gpt-4.1-mini-2025-04-14");
});

test("gateway mode stays off until ORCHESTRA_POOL and the gateway key are set", () => {
  assert.equal(workspace().gatewayAvailable, false);
  assert.ok(workspace().models.every((m) => !m.gateway));
  assert.throws(() => previewRequest(gatewayInput()), /not configured/);
  process.env.ORCHESTRA_POOL = "ollama";
  assert.equal(workspace().gatewayAvailable, false);
  process.env.LITELLM_MASTER_KEY = "test-gateway-master-key";
  assert.equal(workspace().gatewayAvailable, true);
  assert.equal(workspace().gatewayPool, ollama.label);
});

test("gateway previews only rank gateway models, and other modes exclude them", () => {
  process.env.ORCHESTRA_POOL = "ollama";
  process.env.LITELLM_MASTER_KEY = "test-gateway-master-key";
  const preview = previewRequest(gatewayInput());
  assert.ok(preview.selected?.model.gateway);
  for (const c of preview.candidates.filter((c) => !c.model.gateway))
    assert.ok(
      c.reasons.includes(
        "Gateway execution requires a model configured in LiteLLM.",
      ),
    );
  assert.ok(
    preview.policy.assumptions.some((a) => a.includes("shadow prices")),
  );

  const simulation = previewRequest(gatewayInput({ mode: "simulation" }));
  assert.equal(simulation.selected?.model.gateway, undefined);
  for (const c of simulation.candidates.filter((c) => c.model.gateway))
    assert.equal(c.eligible, false);
});

test("a gateway run sends the selected alias, records the shadow cost, and spends the scenario budget", async () => {
  const gateway = await fakeGateway();
  try {
    const before = workspace().balances.gateway;
    assert.equal(before.spent, DEFAULT_SETTINGS.openingSpend);
    const record = await runRequest(gatewayInput(), randomUUID());
    assert.equal(record.status, "completed", record.error ?? "");
    const alias = record.preview.selected!.model.id;
    assert.deepEqual(gateway.calls, [alias]);
    assert.notEqual(alias, "smart-router");
    assert.equal(record.response, `answer from ${alias}`);
    const provider = ollama.models.find(
      (m) => m.alias === alias,
    )!.providerModel;
    assert.equal(record.actualCost, calculateGenerationCost(provider, 40, 120));
    assert.equal(record.simulatedCost, 0);
    assert.equal(record.inputTokens, 40);
    assert.ok(record.measuredLatencyMs !== null);
    assert.equal(record.gateway?.shadowPriced, true);
    assert.equal(record.gateway?.costBasis, "estimated");
    const after = workspace().balances.gateway;
    assert.ok(Math.abs(after.spent - before.spent - record.actualCost) < 1e-12);
    assert.equal(after.reserved, 0);
    // The simulation ledger is untouched.
    assert.equal(
      workspace().balances.simulation.spent,
      DEFAULT_SETTINGS.openingSpend,
    );
  } finally {
    await gateway.close();
  }
});

test("a gateway response from a different model fails but keeps its known cost", async () => {
  const gateway = await fakeGateway(() => ({
    returned: "ollama_chat/some-other-model",
  }));
  try {
    const record = await runRequest(gatewayInput(), randomUUID());
    assert.equal(record.status, "failed");
    assert.match(record.error ?? "", /not accepted/);
    assert.equal(record.response, "");
    assert.equal(record.gateway?.returnedModel, "ollama_chat/some-other-model");
  } finally {
    await gateway.close();
  }
});

test("an unreachable gateway fails without spending", async () => {
  process.env.ORCHESTRA_POOL = "ollama";
  process.env.LITELLM_MASTER_KEY = "test-gateway-master-key";
  // A port that was just closed refuses connections (fetch forbids port 1 outright).
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  process.env.LITELLM_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  const record = await runRequest(gatewayInput(), randomUUID());
  assert.equal(record.status, "failed");
  assert.equal(record.actualCost, 0);
  assert.equal(record.gateway?.costBasis, "none");
  assert.equal(
    workspace().balances.gateway.spent,
    DEFAULT_SETTINGS.openingSpend,
  );
});

test("an interrupted gateway run keeps its reservation as spent", () => {
  process.env.ORCHESTRA_POOL = "ollama";
  process.env.LITELLM_MASTER_KEY = "test-gateway-master-key";
  const input = gatewayInput();
  const preview = previewRequest(input);
  // The same reservation runRequest makes before calling the gateway.
  const { id } = transaction(() =>
    reserve(randomUUID(), input, getSettings(), preview),
  );
  assert.equal(
    workspace().balances.gateway.reserved,
    preview.selected!.estimatedCost,
  );
  db()
    .prepare("UPDATE requests SET created_at=? WHERE id=?")
    .run(new Date(Date.now() - 200000).toISOString(), id);
  recoverInterrupted();
  const failed = history().find((r) => r.id === id)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.actualCost, preview.selected!.estimatedCost);
  assert.ok(
    Math.abs(
      workspace().balances.gateway.spent -
        DEFAULT_SETTINGS.openingSpend -
        preview.selected!.estimatedCost,
    ) < 1e-12,
  );
});
