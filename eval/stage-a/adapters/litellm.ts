
/**
 * Stage A baseline. Every request sends the configured alias "smart-router".
 * In eval/stage-a/litellm/config.yaml that alias is LiteLLM's adaptive router:
 * the gateway chooses among gpt-4.1, gpt-4.1-mini, and gpt-4.1-nano with its
 * own quality/cost weights. Orchestra does not use this class. It selects one
 * alias in lib/engine.ts and sends that alias, so this router cannot replace it.
 */
import type {
    RouterAdapter,
    RouterRequest,
    RouterResult,
  } from "./base";
  
  const LITELLM_URL =
    process.env.LITELLM_URL ??
    "http://localhost:4000/v1/chat/completions";
  
  export class LiteLLMAdapter implements RouterAdapter {
    readonly name = "litellm" as const;
  
    async route(request: RouterRequest): Promise<RouterResult> {
      const start = performance.now();
  
      try {
        const apiKey = process.env.LITELLM_MASTER_KEY;
  
        if (!apiKey) {
          throw new Error("LITELLM_MASTER_KEY is not configured.");
        }
  
        const response = await fetch(LITELLM_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "smart-router",
            messages: [
              {
                role: "user",
                content: request.prompt,
              },
            ],
          }),
        });
  
        const data = await response.json();
  
        if (!response.ok) {
          throw new Error(
            data.error?.message ?? `HTTP ${response.status}`,
          );
        }
  
        const selectedModel =
          response.headers.get("x-litellm-adaptive-router-model") ??
          response.headers.get("x-litellm-model-name");
  
        const costHeader = response.headers.get(
          "x-litellm-response-cost",
        );
  
        const costUsd =
          costHeader !== null ? Number(costHeader) : null;
  
        const content = data.choices?.[0]?.message?.content ?? null;
  
        return {
          router: this.name,
          requestId: request.id,
          success: typeof content === "string",
          selectedModel,
          provider: "openai",
          response: content,
          latencyMs: performance.now() - start,
          inputTokens: data.usage?.prompt_tokens ?? null,
          outputTokens: data.usage?.completion_tokens ?? null,
          costUsd:
            costUsd !== null && Number.isFinite(costUsd)
              ? costUsd
              : null,
          error:
            typeof content === "string"
              ? null
              : "No text response returned.",
        };
      } catch (error) {
        return {
          router: this.name,
          requestId: request.id,
          success: false,
          selectedModel: null,
          provider: null,
          response: null,
          latencyMs: performance.now() - start,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          error:
            error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  