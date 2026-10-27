import type { Importance } from "./types";

export interface TaskClassification {
  difficulty: Importance;
  importance: Importance;
  confidence: number;
  explanation: string;
  method: "prompt-rules-v1";
  costUsd: number;
  latencyMs: number;
}

/** Prompt-only estimates: difficulty describes effort, importance describes consequences. */
export function classifyTask(prompt: string): TaskClassification {
  const started = performance.now();
  const complex =
    /distributed|concurren|race condition|architecture|multi.step|optimi[sz]|security audit|migration|algorithm.*complexity/i.test(
      prompt,
    );
  const routine =
    /simple|basic|routine|hello world|rename|format|sort|reverse|short|casual|birthday/i.test(
      prompt,
    );
  const stakes =
    /medical|patient|diagnos|legal|court|regulator|compliance|financial|security|production|incident|breach|safety|termination|layoff/i.test(
      prompt,
    );
  const casual =
    /casual|birthday|friend|poem|joke|hobby|toy|practice|hello world/i.test(
      prompt,
    );
  const difficulty: Importance = complex ? "high" : routine ? "low" : "medium";
  const importance: Importance = stakes
    ? "high"
    : casual || routine
      ? "low"
      : "medium";
  return {
    difficulty,
    importance,
    confidence: stakes || complex || routine || casual ? 0.8 : 0.35,
    explanation: `Effort: ${complex ? "complex reasoning or systems work" : routine ? "routine bounded task" : "unclear scope; medium default"}. Consequences: ${stakes ? "explicit high-stakes context" : casual || routine ? "routine or casual context" : "unspecified; medium default"}.`,
    method: "prompt-rules-v1",
    costUsd: 0,
    latencyMs: performance.now() - started,
  };
}
