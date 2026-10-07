import type { ModelProfile, RequestInput, RunRecord, Task } from "./types";
import { AppError } from "./db";
import { BENCHMARK_PROMPTS } from "./benchmark";

export function localProfile(records: RunRecord[]): ModelProfile | null {
  const model = process.env.OLLAMA_MODEL?.trim();
  if (!model) return null;
  const id = `local:${model}`;
  const quality = { coding: 0, analysis: 0, writing: 0, qa: 0 };
  const latency = { coding: 60, analysis: 60, writing: 60, qa: 60 };
  let sampleCount = 0;
  const qualitySampleCounts = { coding: 0, analysis: 0, writing: 0, qa: 0 };
  const calibration = new Set(
    BENCHMARK_PROMPTS.filter((p) => p.split === "calibration").map(
      (p) => p.prompt,
    ),
  );
  const calibrated = records.filter(
    (r) =>
      r.input.mode === "local" &&
      r.status === "completed" &&
      r.preview.selected?.model.id === id &&
      r.rating &&
      calibration.has(r.input.prompt),
  );
  // Average once per prompt; repeated ratings or retries do not multiply a prompt's weight.
  const unique = new Map<string, RunRecord>();
  for (const r of calibrated) unique.set(r.input.prompt, r);
  for (const task of Object.keys(quality) as Task[]) {
    const matching = [...unique.values()].filter((r) => r.input.task === task);
    qualitySampleCounts[task] = matching.length;
    if (matching.length) {
      quality[task] =
        matching.reduce((s, r) => s + r.rating!.score, 0) / matching.length;
      sampleCount += matching.length;
    }
    const timings = records.filter(
      (r) =>
        r.input.mode === "local" &&
        r.status === "completed" &&
        r.preview.selected?.model.id === id &&
        r.input.task === task &&
        r.measuredLatencyMs !== null &&
        calibration.has(r.input.prompt),
    );
    if (timings.length)
      latency[task] =
        timings.reduce((s, r) => s + r.measuredLatencyMs!, 0) /
        timings.length /
        1000;
  }
  const context = Number(process.env.OLLAMA_CONTEXT_WINDOW || 8192);
  return {
    id,
    name: model,
    provider: "Local · Ollama",
    tier: "Local",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: Number.isFinite(context) && context >= 512 ? context : 8192,
    quality,
    latency,
    source: sampleCount ? "measured" : "illustrative",
    measuredAt: sampleCount ? calibrated.at(-1)!.createdAt : null,
    sampleCount,
    qualitySampleCounts,
    local: true,
  };
}
export async function generateLocal(input: RequestInput): Promise<{
  response: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}> {
  const model = process.env.OLLAMA_MODEL?.trim();
  if (!model)
    throw new AppError(
      "Local inference is not configured. Set OLLAMA_MODEL in .env.local and restart the app.",
    );
  const base = new URL(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new AppError(
      "The prototype only connects to a local Ollama endpoint.",
    );
  const start = performance.now();
  try {
    const result = await fetch(new URL("/api/generate", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        stream: false,
        options: {
          num_predict: input.outputTokens,
          temperature: 0,
          num_ctx: Number(process.env.OLLAMA_CONTEXT_WINDOW || 8192),
        },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!result.ok)
      throw new Error(
        `Local inference returned HTTP ${result.status}. Check that the configured model is installed.`,
      );
    const body = await result.json();
    if (
      typeof body.response !== "string" ||
      !body.response.trim() ||
      body.done !== true
    )
      throw new Error(
        "Local inference returned an incomplete or empty response.",
      );
    if (
      !Number.isInteger(body.prompt_eval_count) ||
      body.prompt_eval_count < 0 ||
      !Number.isInteger(body.eval_count) ||
      body.eval_count < 0
    )
      throw new Error("Local inference did not return valid token usage.");
    return {
      response: body.response,
      inputTokens: body.prompt_eval_count,
      outputTokens: body.eval_count,
      latencyMs: performance.now() - start,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name)
    )
      throw new AppError(
        "Local inference timed out after 120 seconds. No API charge was recorded.",
        504,
      );
    throw new AppError(
      error instanceof Error
        ? error.message
        : "Could not connect to local inference.",
      502,
    );
  }
}
