import type { RunRecord } from "../lib/types";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  demoApi,
  demoPreview,
  demoRun,
  demoWorkspace,
  emptyDemoState,
} from "../lib/demo";
import { DEFAULT_INPUT } from "../lib/catalog";
import { db } from "../lib/db";
import {
  GET as workspaceGET,
  POST as workspacePOST,
} from "../app/api/workspace/route";
import { GET as historyGET } from "../app/api/history/route";
import { GET as exportGET } from "../app/api/export/route";
import { POST as previewPOST } from "../app/api/preview/route";
import { POST as runPOST } from "../app/api/run/route";
import { POST as ratingsPOST } from "../app/api/ratings/route";
import { POST as evaluatePOST } from "../app/api/evaluate/route";
import { enableBrowserDemo, browserDemoApi } from "../lib/demo-client";

const request = (patch = {}) => ({
  ...structuredClone(DEFAULT_INPUT),
  importanceMode: "inferred" as const,
  ...patch,
});
afterEach(() => {
  delete process.env.VERCEL;
  delete process.env.ORCHESTRA_PUBLIC_DEMO;
  delete process.env.ORCHESTRA_DB_PATH;
});

test("Vercel workspace boots without touching an unwritable database or provider config", async () => {
  process.env.VERCEL = "1";
  process.env.ORCHESTRA_DB_PATH = "/var/task/data/forbidden.sqlite";
  const response = await workspaceGET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const workspace = await response.json();
  assert.equal(workspace.storage, "browser");
  assert.deepEqual(workspace.history, []);
  assert.equal(workspace.defaultInput.importanceMode, "inferred");
  assert.equal(workspace.gatewayAvailable, false);
  assert.equal(workspace.localAvailable, false);
  assert.throws(() => db(), /storage is disabled/);
});

test("every deployed workspace read/write endpoint fails closed before reading request data", async () => {
  process.env.ORCHESTRA_PUBLIC_DEMO = "1";
  process.env.ORCHESTRA_DB_PATH = "/var/task/data/forbidden.sqlite";
  for (const handler of [
    workspacePOST,
    previewPOST,
    runPOST,
    ratingsPOST,
    evaluatePOST,
    exportGET,
  ]) {
    const response = await handler(
      new Request("http://localhost/api/test", {
        method: "POST",
        body: "invalid JSON",
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await historyGET()).status, 403);
});

test("browser visitors never share settings, history, idempotency keys or budgets", () => {
  const a = emptyDemoState(),
    b = emptyDemoState();
  const input = request({ prompt: "Review a production security incident" });
  const key = randomUUID();
  const before = demoWorkspace(b);
  demoRun(a, { input, idempotencyKey: key });
  demoApi(a, "/api/workspace", {
    ...a.settings,
    teamName: "Visitor A private team",
  });
  assert.deepEqual(demoWorkspace(b), before);
  assert.equal(
    (demoApi(b, "/api/export") as { records: unknown[] }).records.length,
    0,
  );
  assert.equal(demoRun(b, { input, idempotencyKey: key }).status, "completed");
  assert.equal(a.runs.length, 1);
  assert.equal(b.runs.length, 1);
});

test("automatic/manual preview and execution use the same classification and unchanged policy", () => {
  for (const importanceMode of ["inferred", "fixed"] as const) {
    const state = emptyDemoState();
    const input = request({
      importanceMode,
      importance: "low",
      prompt: "Review a distributed production security incident",
    });
    const preview = demoPreview(state, input);
    const key = randomUUID();
    const run = demoRun(state, { input, idempotencyKey: key });
    assert.deepEqual(run.preview.policy, preview.policy);
    assert.deepEqual(run.preview.candidates, preview.candidates);
    assert.equal(
      run.input.importance,
      importanceMode === "inferred" ? "high" : "low",
    );
    assert.equal(
      preview.classification?.difficulty,
      importanceMode === "inferred" ? "high" : undefined,
    );
    assert.equal(run.actualCost, 0);
    assert.match(run.response, /SIMULATED EXECUTION/);
    assert.equal(demoRun(state, { input, idempotencyKey: key }).id, run.id);
    assert.equal(state.runs.length, 1);
  }
});

test("simulation ledger preserves draft budgets, scenario/month scopes, and rejection explanations", () => {
  const state = emptyDemoState(),
    input = request();
  const initial = demoWorkspace(state).balances.simulation.spent;
  const run = demoRun(state, { input, idempotencyKey: randomUUID() });
  assert.equal(
    demoWorkspace(state).balances.simulation.spent,
    initial + run.simulatedCost,
  );
  const saved = structuredClone(state.settings);
  assert.equal(
    demoPreview(state, input, { ...saved, monthlyBudget: 0 }).selected,
    null,
  );
  assert.deepEqual(state.settings, saved);
  const rejected = demoRun(state, {
    input: { ...input, maxRequestCost: 0, qualityFloor: 1 },
    idempotencyKey: randomUUID(),
  });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.error!, /quality is below/);
  assert.match(rejected.error!, /cost exceeds/);
  assert.equal(
    demoWorkspace(state).balances.simulation.spent,
    initial + run.simulatedCost,
  );
  demoApi(state, "/api/workspace", {
    ...saved,
    simulatedDate: "2026-11-01",
    openingSpend: 0,
  });
  assert.equal(demoWorkspace(state).balances.simulation.spent, 0);
  assert.equal(demoWorkspace(state).history.length, 2);
});

test("public demo cannot execute local/gateway requests or rate simulation", () => {
  for (const mode of ["local", "gateway"]) {
    assert.throws(
      () => demoPreview(emptyDemoState(), request({ mode })),
      /simulation only/,
    );
    assert.throws(
      () =>
        demoRun(emptyDemoState(), {
          input: request({ mode }),
          idempotencyKey: randomUUID(),
        }),
      /simulation only/,
    );
  }
  assert.throws(
    () => demoApi(emptyDemoState(), "/api/ratings", {}),
    /unavailable/,
  );
});

test("browser event storage restores settings, run identity, budget and history on reload", () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  enableBrowserDemo();
  browserDemoApi("/api/workspace", {
    ...emptyDemoState().settings,
    teamName: "My browser",
  });
  const run = browserDemoApi<{ id: string }>("/api/run", {
    input: request(),
    idempotencyKey: randomUUID(),
  });
  const before =
    browserDemoApi<ReturnType<typeof demoWorkspace>>("/api/workspace");
  enableBrowserDemo();
  const after =
    browserDemoApi<ReturnType<typeof demoWorkspace>>("/api/workspace");
  assert.equal(after.settings.teamName, "My browser");
  assert.equal(after.history[0].id, run.id);
  assert.deepEqual(after.balances, before.balances);
  assert.deepEqual(
    after.history[0].preview.policy,
    before.history[0].preview.policy,
  );
  storage.clear();
  enableBrowserDemo();
  assert.equal(
    browserDemoApi<ReturnType<typeof demoWorkspace>>("/api/workspace").history
      .length,
    0,
  );
});

test("unavailable or corrupt browser storage gives a usable workspace and visible limitation", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => "broken json",
      setItem: () => {
        throw new Error("quota");
      },
    },
  });
  enableBrowserDemo();
  const run = browserDemoApi<RunRecord>("/api/run", {
    input: request(),
    idempotencyKey: randomUUID(),
  });
  assert.equal(run.status, "completed");
  const workspace = browserDemoApi<
    ReturnType<typeof demoWorkspace> & { storageNotice: string }
  >("/api/workspace");
  assert.match(workspace.storageNotice, /lost on reload/);
  assert.equal(workspace.history.length, 1);
});
