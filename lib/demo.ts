import { DEFAULT_INPUT, DEFAULT_SETTINGS, MODELS } from "./catalog";
import { resolvedPreview } from "./preview";
import { simulate } from "./simulation";
import { inputSchema, runSchema, settingsSchema } from "./validation";
import { evaluate, BENCHMARK_PROMPTS } from "./benchmark";
import type { RequestInput, RunRecord, Settings, Workspace } from "./types";

export type DemoState = {
  settings: Settings;
  runs: { key: string; hash: string; record: RunRecord; scope: string }[];
};
export const emptyDemoState = (): DemoState => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  runs: [],
});
const scope = (settings: Settings) =>
  `${settings.scenario}:${settings.simulatedDate.slice(0, 7)}`;
function context(state: DemoState, input: RequestInput) {
  let spent = state.settings.openingSpend,
    userSpent = 0,
    completedRequests = 0;
  for (const run of state.runs) {
    if (
      run.scope !== scope(state.settings) ||
      run.record.status !== "completed"
    )
      continue;
    spent += run.record.simulatedCost;
    if (run.record.input.userId === input.userId)
      userSpent += run.record.simulatedCost;
    completedRequests++;
  }
  return { spent, userSpent, completedRequests, reserved: 0, userReserved: 0 };
}
export function demoWorkspace(
  state: DemoState,
): Workspace & { defaultInput: RequestInput; storage: "browser" } {
  const defaultInput: RequestInput = {
    ...structuredClone(DEFAULT_INPUT),
    importanceMode: "inferred",
    userId: state.settings.users.some((u) => u.id === DEFAULT_INPUT.userId)
      ? DEFAULT_INPUT.userId
      : state.settings.users[0].id,
  };
  const c = context(state, defaultInput);
  const empty = {
    spent: 0,
    reserved: 0,
    remaining: state.settings.monthlyBudget,
  };
  return {
    storage: "browser",
    settings: state.settings,
    models: structuredClone(MODELS),
    history: state.runs
      .slice(-500)
      .reverse()
      .map((run) => run.record),
    balances: {
      simulation: {
        spent: c.spent,
        reserved: 0,
        remaining: Math.max(0, state.settings.monthlyBudget - c.spent),
      },
      local: empty,
      gateway: empty,
    },
    localAvailable: false,
    localModel: null,
    localQualityReady: false,
    gatewayAvailable: false,
    gatewayPool: null,
    defaultInput,
  };
}
export function demoPreview(state: DemoState, raw: unknown, draft?: unknown) {
  const input = inputSchema.parse(raw);
  if (input.mode !== "simulation")
    throw new Error("The public demo supports simulation only.");
  const settings =
    draft === undefined ? state.settings : settingsSchema.parse(draft);
  if (!settings.users.some((user) => user.id === input.userId))
    throw new Error("Choose a user who belongs to this workspace.");
  const start = performance.now();
  const preview = resolvedPreview(
    input,
    settings,
    MODELS,
    context({ ...state, settings }, input),
  );
  preview.routingMs = performance.now() - start;
  return preview;
}
export function demoRun(state: DemoState, payload: unknown): RunRecord {
  const { input, idempotencyKey } = runSchema.parse(payload);
  if (input.mode !== "simulation")
    throw new Error("The public demo supports simulation only.");
  const hash = JSON.stringify(input);
  const previous = state.runs.find((run) => run.key === idempotencyKey);
  if (previous) {
    if (previous.hash !== hash)
      throw new Error("This request key was already used for different input.");
    return previous.record;
  }
  const preview = demoPreview(state, input);
  const record: RunRecord = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    month: state.settings.simulatedDate.slice(0, 7),
    input: { ...input, importance: preview.policy.importance },
    preview,
    status: preview.selected ? "completed" : "rejected",
    response: "",
    simulatedCost: 0,
    actualCost: 0,
    simulatedLatency: null,
    measuredLatencyMs: null,
    inputTokens: 0,
    outputTokens: 0,
    rating: null,
    error: preview.selected ? null : preview.rejectionReason!,
  };
  if (preview.selected)
    Object.assign(record, simulate(input, preview.selected));
  state.runs.push({
    key: idempotencyKey,
    hash,
    record,
    scope: scope(state.settings),
  });
  return record;
}
export function demoApi(
  state: DemoState,
  path: string,
  payload?: unknown,
): unknown {
  switch (path) {
    case "/api/workspace":
      if (payload !== undefined) state.settings = settingsSchema.parse(payload);
      return demoWorkspace(state);
    case "/api/preview": {
      const b = payload as { input: unknown; settings?: unknown };
      return demoPreview(state, b?.input, b?.settings);
    }
    case "/api/run":
      return demoRun(state, payload);
    case "/api/history":
      return demoWorkspace(state).history;
    case "/api/evaluate": {
      if (payload === undefined) return { prompts: BENCHMARK_PROMPTS };
      const b = payload as { input: unknown; settings?: unknown };
      const input = inputSchema.parse(b?.input);
      if (input.mode !== "simulation")
        throw new Error("The public demo supports simulation only.");
      return evaluate(
        b.settings === undefined
          ? state.settings
          : settingsSchema.parse(b.settings),
        MODELS,
        input,
      );
    }
    case "/api/export":
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: state.settings,
        records: state.runs.map((run) => run.record),
      };
    default:
      throw new Error(
        "This action is unavailable in the public simulation demo.",
      );
  }
}
