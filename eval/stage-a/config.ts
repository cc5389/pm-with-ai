
export const STAGE_A_CONFIG = {
    experiment: "stage-a-router-comparison",
    version: "1.0",
  
    candidateModels: [
      "gpt-4.1-2025-04-14",
      "gpt-4.1-mini-2025-04-14",
      "gpt-4.1-nano-2025-04-14",
    ],
  
    routers: ["litellm", "notdiamond"],
  
    tasks: ["coding", "analysis", "writing", "qa"],
  
    judge: {
      model: "gpt-4.1-mini-2025-04-14",
      qualityThreshold: 0.75,
      rubricVersion: "1.0",
      temperature: 0,
    },
  
    dataset: {
      totalPrompts: 40,
      calibrationPrompts: 20,
      evaluationPrompts: 20,
      pilotPrompts: 4,
    },
  
    metrics: [
      "quality",
      "qualityPassRate",
      "generationCostUsd",
      "latencyMs",
      "successRate",
    ],
  
    notes: [
      "Same candidate model pool for both routers.",
      "Same task prompts and evaluation rubric.",
      "Judge is blind to router and selected model.",
      "Generation costs exclude router service fees.",
      "Held-out evaluation prompts are not used for calibration.",
      "LiteLLM adaptive routing state may change during the experiment.",
    ],
  } as const;
  