import { demoApi, emptyDemoState } from "./demo";
import type { RunRecord } from "./types";

const STORAGE_KEY = "orchestra-public-simulation-v1";
type Event = {
  path: "/api/workspace" | "/api/run";
  payload: unknown;
  id?: string;
  createdAt?: string;
};
let state = emptyDemoState();
let events: Event[] = [];
let enabled = false;
let storageNotice =
  "Settings and simulation history are saved only in this browser. Clear site data to reset. Do not enter sensitive information on a shared browser.";

export function enableBrowserDemo() {
  enabled = true;
  state = emptyDemoState();
  events = [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error("Invalid saved workspace");
    for (const event of parsed) {
      if (!event || !["/api/workspace", "/api/run"].includes(event.path))
        throw new Error("Invalid saved action");
      const result = demoApi(state, event.path, event.payload);
      if (event.path === "/api/run") {
        if (
          typeof event.id !== "string" ||
          typeof event.createdAt !== "string" ||
          !Number.isFinite(Date.parse(event.createdAt))
        )
          throw new Error("Invalid saved run");
        Object.assign(result as RunRecord, {
          id: event.id,
          createdAt: event.createdAt,
        });
      }
      events.push(event);
    }
  } catch {
    state = emptyDemoState();
    events = [];
    storageNotice =
      "Saved browser data could not be loaded. This workspace starts fresh; export anything you want to keep.";
  }
}
export function browserDemoEnabled() {
  return enabled;
}
export function browserDemoApi<T>(path: string, payload?: unknown): T {
  const result = demoApi(state, path, payload);
  if (
    payload !== undefined &&
    (path === "/api/workspace" || path === "/api/run")
  ) {
    const run = result as RunRecord;
    if (
      path !== "/api/run" ||
      !events.some(
        (event) =>
          event.path === path &&
          (event.payload as { idempotencyKey?: string }).idempotencyKey ===
            (payload as { idempotencyKey?: string }).idempotencyKey,
      )
    ) {
      events.push({
        path,
        payload,
        ...(path === "/api/run"
          ? { id: run.id, createdAt: run.createdAt }
          : {}),
      });
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    } catch {
      storageNotice =
        "Browser storage is unavailable or full. Changes remain in this tab only and will be lost on reload. Export to keep a copy.";
    }
  }
  if (path === "/api/workspace")
    return { ...(result as object), storageNotice } as T;
  return result as T;
}
export function downloadBrowserDemo(csv: boolean) {
  const data = browserDemoApi<{ settings: unknown; records: RunRecord[] }>(
    "/api/export",
  );
  const cell = (value: unknown) =>
    '"' +
    String(value ?? "")
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  const text = csv
    ? [
        [
          "id",
          "created_at",
          "status",
          "task",
          "model",
          "simulated_cost_usd",
          "prompt",
          "response",
        ].join(","),
        ...data.records.map((run) =>
          [
            run.id,
            run.createdAt,
            run.status,
            run.input.task,
            run.preview.selected?.model.id,
            run.simulatedCost,
            run.input.prompt,
            run.response,
          ]
            .map(cell)
            .join(","),
        ),
      ].join("\r\n")
    : JSON.stringify(data, null, 2);
  const url = URL.createObjectURL(
    new Blob([text], { type: csv ? "text/csv" : "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = csv ? "orchestra-history.csv" : "orchestra-workspace.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
