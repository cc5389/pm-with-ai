import { isPublicDemo } from "./deployment";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS } from "./catalog";
import { settingsSchema } from "./validation";
import type {
  BudgetContext,
  Mode,
  Preview,
  RequestInput,
  RunRecord,
  Settings,
} from "./types";

let instance: DatabaseSync | undefined;
export function db() {
  if (isPublicDemo())
    throw new AppError(
      "Server workspace storage is disabled in the public demo.",
      403,
    );
  if (instance) return instance;
  const file =
    process.env.ORCHESTRA_DB_PATH || resolve("data/orchestra.sqlite");
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  instance = new DatabaseSync(file, { timeout: 5000 });
  instance.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, scope TEXT NOT NULL,
      month TEXT NOT NULL, user_id TEXT NOT NULL, mode TEXT NOT NULL, reserved REAL NOT NULL DEFAULT 0,
      state TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT, draft TEXT
    );
    CREATE INDEX IF NOT EXISTS requests_scope ON requests(scope, mode, state);
  `);
  instance
    .prepare("INSERT OR IGNORE INTO settings(id,json) VALUES(1,?)")
    .run(JSON.stringify(DEFAULT_SETTINGS));
  return instance;
}
export function transaction<T>(f: () => T): T {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const out = f();
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}
export function recoverInterrupted() {
  db()
    .prepare(
      "UPDATE requests SET state='failed',reserved=0,json=draft WHERE state='running' AND created_at < ? AND draft IS NOT NULL",
    )
    .run(new Date(Date.now() - 150000).toISOString());
}
export function getSettings(): Settings {
  recoverInterrupted();
  return settingsSchema.parse(
    JSON.parse(
      (
        db().prepare("SELECT json FROM settings WHERE id=1").get() as {
          json: string;
        }
      ).json,
    ),
  );
}
export function saveSettings(settings: Settings) {
  db()
    .prepare("UPDATE settings SET json=? WHERE id=1")
    .run(JSON.stringify(settings));
}
/** Simulation and gateway runs share the scenario calendar; local runs use the real one. */
export function scopeOf(settings: Settings, mode: Mode) {
  return `${mode}:${mode === "local" ? "actual" : settings.scenario}:${monthOf(settings, mode)}`;
}
export function monthOf(settings: Settings, mode: Mode) {
  return mode === "local"
    ? new Date().toISOString().slice(0, 7)
    : settings.simulatedDate.slice(0, 7);
}
export function history(): RunRecord[] {
  recoverInterrupted();
  return (
    db()
      .prepare(
        "SELECT json FROM requests WHERE json IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 500",
      )
      .all() as { json: string }[]
  ).map((r) => JSON.parse(r.json));
}
export function allRecords(): RunRecord[] {
  recoverInterrupted();
  return (
    db()
      .prepare(
        "SELECT json FROM requests WHERE json IS NOT NULL ORDER BY created_at, rowid",
      )
      .all() as { json: string }[]
  ).map((r) => JSON.parse(r.json));
}
export function budgetContext(
  settings: Settings,
  input: RequestInput,
): BudgetContext {
  const rows = db()
    .prepare(
      "SELECT user_id, reserved, state, json FROM requests WHERE scope=?",
    )
    .all(scopeOf(settings, input.mode)) as {
    user_id: string;
    reserved: number;
    state: string;
    json: string | null;
  }[];
  let spent = input.mode === "local" ? 0 : settings.openingSpend,
    reserved = 0,
    userSpent = 0,
    userReserved = 0,
    completedRequests = 0;
  for (const row of rows) {
    if (row.state === "running") {
      reserved += row.reserved;
      if (row.user_id === input.userId) userReserved += row.reserved;
    }
    if (row.json) {
      const r = JSON.parse(row.json) as RunRecord;
      const cost = input.mode === "simulation" ? r.simulatedCost : r.actualCost;
      // A failed gateway call can still carry a known or locked cost.
      if (r.status === "completed" || cost > 0) {
        spent += cost;
        if (row.user_id === input.userId) userSpent += cost;
      }
      if (r.status === "completed") completedRequests++;
    }
  }
  return { spent, reserved, userSpent, userReserved, completedRequests };
}
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function findKey(key: string, input: RequestInput): RunRecord | null {
  const row = db()
    .prepare("SELECT hash,json,state FROM requests WHERE key=?")
    .get(key) as
    { hash: string; json: string | null; state: string } | undefined;
  if (!row) return null;
  if (row.hash !== hash(input))
    throw new AppError(
      "This request key was already used for different input.",
      409,
    );
  if (!row.json)
    throw new AppError(
      "This request is still running. Check history before trying again.",
      409,
    );
  return JSON.parse(row.json);
}
const hash = (input: RequestInput) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
export function reserve(
  key: string,
  input: RequestInput,
  settings: Settings,
  preview: Preview,
) {
  const id = randomUUID(),
    createdAt = new Date().toISOString(),
    reserved =
      input.mode === "local" ? 0 : (preview.selected?.estimatedCost ?? 0);
  db()
    .prepare(
      "INSERT INTO requests(id,key,hash,scope,month,user_id,mode,reserved,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      key,
      hash(input),
      scopeOf(settings, input.mode),
      monthOf(settings, input.mode),
      input.userId,
      input.mode,
      reserved,
      "running",
      createdAt,
    );
  const draft: RunRecord = {
    id,
    createdAt,
    month: monthOf(settings, input.mode),
    input,
    preview,
    status: "failed",
    response: "",
    simulatedCost: 0,
    // The gateway may have accepted an interrupted call, so its reservation stays locked.
    actualCost: input.mode === "gateway" ? reserved : 0,
    simulatedLatency: null,
    measuredLatencyMs: null,
    inputTokens: 0,
    outputTokens: 0,
    rating: null,
    error:
      input.mode === "gateway"
        ? "The gateway request was interrupted before completion. Its reservation stays locked as an unresolved cost."
        : "The local request was interrupted before completion. No API charge was recorded.",
  };
  db()
    .prepare("UPDATE requests SET draft=? WHERE id=?")
    .run(JSON.stringify(draft), id);
  return { id, createdAt, month: monthOf(settings, input.mode) };
}
export function saveRecord(record: RunRecord) {
  db()
    .prepare("UPDATE requests SET state=?,reserved=0,json=? WHERE id=?")
    .run(record.status, JSON.stringify(record), record.id);
}
export function getRecord(id: string): RunRecord {
  const row = db().prepare("SELECT json FROM requests WHERE id=?").get(id) as
    { json: string | null } | undefined;
  if (!row?.json) throw new AppError("Request not found.", 404);
  return JSON.parse(row.json);
}
