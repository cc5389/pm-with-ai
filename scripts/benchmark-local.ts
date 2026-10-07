/** Run against an already-started Orchestra app; no external or paid API calls. */
import { BENCHMARK_PROMPTS } from "../lib/benchmark";
import { randomUUID } from "node:crypto";
const base = new URL(process.env.ORCHESTRA_URL || "http://127.0.0.1:3000");
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
  throw new Error("Use a local Orchestra URL.");
const args = process.argv.slice(2),
  split = args.includes("--evaluation") ? "evaluation" : "calibration";
const state = await fetch(new URL("/api/workspace", base)).then((r) =>
  r.json(),
);
if (!state.localAvailable)
  throw new Error("Configure OLLAMA_MODEL and restart the app first.");
for (const prompt of BENCHMARK_PROMPTS.filter((p) => p.split === split)) {
  const input = {
    ...state.defaultInput,
    prompt: prompt.prompt,
    task: prompt.task,
    mode: "local",
    localOnly: true,
    qualityFloor: 0,
    strictLatency: false,
    userId: state.settings.users[0].id,
  };
  const response = await fetch(new URL("/api/run", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, idempotencyKey: randomUUID() }),
  });
  const record = await response.json();
  if (!response.ok) throw new Error(record.error || "Run failed");
  console.log(
    `${prompt.id} ${record.status} ${record.id} ${record.measuredLatencyMs === null ? "—" : Math.round(record.measuredLatencyMs) + " ms"}`,
  );
  if (record.status !== "completed")
    throw new Error(record.error || "Request not completed");
}
console.log(
  "Rate the responses in History. Calibration ratings update profiles; held-out evaluation ratings do not.",
);
