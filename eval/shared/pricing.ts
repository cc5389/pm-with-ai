
export const MODEL_PRICING = {
    "gpt-4.1-2025-04-14": {
      input: 0.000002,
      output: 0.000008,
    },
    "gpt-4.1-mini-2025-04-14": {
      input: 0.0000004,
      output: 0.0000016,
    },
    "gpt-4.1-nano-2025-04-14": {
      input: 0.0000001,
      output: 0.0000004,
    },
  } as const;
  
  // Frozen pricing snapshot for reproducible evaluation.
  // USD per token, retrieved from LiteLLM on 2026-10-07.
  
  export function calculateGenerationCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number | null {
    const normalizedModel = model.replace(/^openai\//, "");
  
    const pricing =
      MODEL_PRICING[normalizedModel as keyof typeof MODEL_PRICING];
  
    if (!pricing) {
      return null;
    }
  
    return (
      inputTokens * pricing.input +
      outputTokens * pricing.output
    );
  }
  