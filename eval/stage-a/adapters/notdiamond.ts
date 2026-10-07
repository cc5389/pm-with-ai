
import OpenAI from "openai";
import NotDiamond from "notdiamond";
import { calculateGenerationCost } from "../../shared/pricing";

import type {
  RouterAdapter,
  RouterRequest,
  RouterResult,
} from "./base";

const CANDIDATE_MODELS = [
  { provider: "openai", model: "gpt-4.1-2025-04-14" },
  { provider: "openai", model: "gpt-4.1-mini-2025-04-14" },
  { provider: "openai", model: "gpt-4.1-nano-2025-04-14" },
];

export class NotDiamondAdapter implements RouterAdapter {
  readonly name = "notdiamond" as const;

  private routerClient: NotDiamond;
  private openaiClient: OpenAI;

  constructor() {
    const routerKey = process.env.NOTDIAMOND_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!routerKey || !openaiKey) {
      throw new Error(
        "NOTDIAMOND_API_KEY and OPENAI_API_KEY must be configured.",
      );
    }

    this.routerClient = new NotDiamond({ apiKey: routerKey });
    this.openaiClient = new OpenAI({ apiKey: openaiKey });
  }

  async route(request: RouterRequest): Promise<RouterResult> {
    const start = performance.now();
    let selectedModel: string | null = null;

    try {
      // Step 1: Let Not Diamond select a model.
      const routing = await this.routerClient.modelRouter.selectModel({
        messages: [
          {
            role: "user",
            content: request.prompt,
          },
        ],
        llm_providers: CANDIDATE_MODELS,
      });

      const selected = routing.providers[0];

      if (!selected) {
        throw new Error("Not Diamond did not select a model.");
      }

      selectedModel = selected.model;

      // Step 2: Generate an answer using the selected model.
      const completion = await this.openaiClient.chat.completions.create({
        model: selectedModel,
        messages: [
          {
            role: "user",
            content: request.prompt,
          },
        ],
      });

      const content = completion.choices[0]?.message?.content ?? null;

      return {
        router: this.name,
        requestId: request.id,
        success: typeof content === "string",
        selectedModel,
        provider: selected.provider,
        response: content,
        latencyMs: performance.now() - start,
        inputTokens: completion.usage?.prompt_tokens ?? null,
        outputTokens: completion.usage?.completion_tokens ?? null,
        costUsd:
          completion.usage && selectedModel
            ? calculateGenerationCost(
                selectedModel,
                completion.usage.prompt_tokens,
                completion.usage.completion_tokens,
              )
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
        selectedModel,
        provider: selectedModel ? "openai" : null,
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
