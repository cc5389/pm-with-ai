import { allowProviderRetry } from "./accounting";
import { calculateGenerationCost } from "./pricing";
import { activePool, pricingModelId } from "./model-pool";

export const LITELLM_TIMEOUT_MS = 120_000;

const DEFAULT_URL = "http://127.0.0.1:4000/v1/chat/completions";

const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
]);

export class LiteLLMConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMConfigurationError";
  }
}

export type LiteLLMTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface LiteLLMCompletion {
  success: boolean;
  outcome: "completed" | "failed";
  requestedModel: string;
  returnedModel: string | null;
  response: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costBasis: "actual" | "estimated" | "none" | "unknown";
  error: string | null;
  attempts: number;
  providerContacted: boolean;
  outputTokenCap: number;
}

export function assertLoopbackGateway(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LiteLLMConfigurationError("LITELLM_URL is not a valid URL.");
  }
  const host = url.hostname.toLowerCase();
  if (
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) ||
    url.username ||
    url.password ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    throw new LiteLLMConfigurationError(
      "LiteLLM requests are limited to a loopback gateway.",
    );
  }
  return url;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return errorCode((error as { cause?: unknown }).cause);
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/** Retry only when no HTTP response arrived. A timeout may already have been billed. */
export function isRetryableConnectionError(error: unknown): boolean {
  if (isTimeout(error)) return false;
  const code = errorCode(error);
  return code !== undefined && CONNECTION_CODES.has(code);
}

function redact(text: string, secret: string): string {
  if (secret.length < 8) return text;
  return text.split(secret).join("[redacted]");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readPayload(data: unknown): {
  content: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  message: string | null;
} {
  const body = asRecord(data);
  const error = asRecord(body?.error);
  const message = typeof error?.message === "string" ? error.message : null;
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  const choice = asRecord(choices[0]);
  const responseMessage = asRecord(choice?.message);
  const content =
    typeof responseMessage?.content === "string"
      ? responseMessage.content
      : null;
  const usage = asRecord(body?.usage);
  return {
    content,
    inputTokens: integer(usage?.prompt_tokens),
    outputTokens: integer(usage?.completion_tokens),
    message,
  };
}

function readCost(
  response: Response,
  pricedModel: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  trustHeader: boolean,
): { costUsd: number | null; costBasis: "actual" | "estimated" | "unknown" } {
  const header = trustHeader
    ? response.headers.get("x-litellm-response-cost")
    : null;
  if (header !== null && header.trim() !== "") {
    const value = Number(header);
    if (Number.isFinite(value) && value >= 0) {
      return { costUsd: value, costBasis: "actual" };
    }
  }
  if (pricedModel && inputTokens !== null && outputTokens !== null) {
    const estimated = calculateGenerationCost(
      pricedModel,
      inputTokens,
      outputTokens,
    );
    if (estimated !== null && Number.isFinite(estimated) && estimated >= 0) {
      return { costUsd: estimated, costBasis: "estimated" };
    }
  }
  return { costUsd: null, costBasis: "unknown" };
}

function returnedModel(response: Response, requested: string): string | null {
  const named = response.headers.get("x-litellm-model-name");
  const adaptive = response.headers.get("x-litellm-adaptive-router-model");
  const value = requested === "smart-router" ? (adaptive ?? named) : (named ?? adaptive);
  return value && value.trim() ? value.trim() : null;
}

const defaultTransport: LiteLLMTransport = (url, init) => fetch(url, init);

export async function completeLiteLLM(options: {
  model: string;
  prompt: string;
  maxTokens: number;
  transport?: LiteLLMTransport;
  url?: string;
  apiKey?: string;
  remainingUsd?: number;
  reservedUsd?: number;
}): Promise<LiteLLMCompletion> {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
    throw new LiteLLMConfigurationError(
      "The output token cap must be a positive integer.",
    );
  }
  const apiKey = (options.apiKey ?? process.env.LITELLM_MASTER_KEY ?? "").trim();
  if (!apiKey) {
    throw new LiteLLMConfigurationError(
      "LITELLM_MASTER_KEY is not configured.",
    );
  }
  const url = assertLoopbackGateway(
    options.url ?? process.env.LITELLM_URL ?? DEFAULT_URL,
  );
  const transport = options.transport ?? defaultTransport;
  const started = performance.now();
  let attempts = 0;
  let providerContacted = false;

  const fail = (
    error: unknown,
    contacted: boolean,
  ): LiteLLMCompletion => ({
    success: false,
    outcome: "failed",
    requestedModel: options.model,
    returnedModel: null,
    response: null,
    latencyMs: Math.max(0, performance.now() - started),
    inputTokens: null,
    outputTokens: null,
    costUsd: contacted ? null : 0,
    costBasis: contacted ? "unknown" : "none",
    error: redact(
      error instanceof Error ? error.message : "LiteLLM request failed.",
      apiKey,
    ),
    attempts,
    providerContacted: contacted,
    outputTokenCap: options.maxTokens,
  });

  while (attempts < 2) {
    attempts += 1;
    try {
      const response = await transport(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content: options.prompt }],
          max_tokens: options.maxTokens,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(LITELLM_TIMEOUT_MS),
      });
      providerContacted = true;
      const payload = readPayload(await response.json().catch(() => ({})));
      const modelName = returnedModel(response, options.model);
      const priced = pricingModelId(modelName ?? options.model);
      const cost = readCost(
        response,
        priced,
        payload.inputTokens,
        payload.outputTokens,
        !activePool().shadowPriced,
      );
      const success = response.ok && typeof payload.content === "string";
      const error = success
        ? null
        : redact(
            payload.message ??
              (response.ok
                ? "No text response returned."
                : `LiteLLM gateway returned HTTP ${response.status}.`),
            apiKey,
          );
      return {
        success,
        outcome: success ? "completed" : "failed",
        requestedModel: options.model,
        returnedModel: modelName,
        response: payload.content,
        latencyMs: Math.max(0, performance.now() - started),
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        costUsd: cost.costUsd,
        costBasis: cost.costBasis,
        error,
        attempts,
        providerContacted,
        outputTokenCap: options.maxTokens,
      };
    } catch (error) {
      const connectionError = isRetryableConnectionError(error);
      if (
        allowProviderRetry({
          attempt: attempts,
          providerContacted,
          connectionError,
          remainingUsd: options.remainingUsd ?? Number.NaN,
          reservedUsd: options.reservedUsd ?? Number.NaN,
        })
      ) {
        continue;
      }
      // Only a connection failure is known to be unbilled. Timeouts and other
      // errors may have reached the gateway, so the caller locks the reservation.
      return fail(error, !connectionError);
    }
  }

  return fail(new Error("LiteLLM request failed."), providerContacted);
}
