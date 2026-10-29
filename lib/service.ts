import { classifyTask } from "./classification";
import { buildPreview, qualityScore } from "./engine";
import { MODELS, DEFAULT_INPUT } from "./catalog";
import {
  allRecords,
  AppError,
  budgetContext,
  findKey,
  getRecord,
  getSettings,
  history,
  reserve,
  saveRecord,
  transaction,
} from "./db";
import { generateLocal, localProfile } from "./local";
import {
  gatewayAssumptions,
  gatewayPool,
  gatewayProfiles,
  generateGateway,
} from "./gateway";
import type {
  Preview,
  RequestInput,
  RunRecord,
  Settings,
  Workspace,
} from "./types";

export function workspace(): Workspace & { defaultInput: RequestInput } {
  const records = allRecords(),
    local = localProfile(records),
    settings = getSettings(),
    pool = gatewayPool();
  const defaultInput: RequestInput = {
    ...DEFAULT_INPUT,
    importanceMode: "inferred",
    // A configured gateway is an explicit opt-in, so start there after a reload.
    mode: pool ? "gateway" : DEFAULT_INPUT.mode,
    userId: settings.users.some((u) => u.id === DEFAULT_INPUT.userId)
      ? DEFAULT_INPUT.userId
      : settings.users[0].id,
  };
  const balance = (mode: RequestInput["mode"]) => {
    const c = budgetContext(settings, { ...defaultInput, mode });
    return {
      spent: c.spent,
      reserved: c.reserved,
      remaining: Math.max(0, settings.monthlyBudget - c.spent - c.reserved),
    };
  };
  return {
    settings,
    balances: {
      simulation: balance("simulation"),
      local: balance("local"),
      gateway: balance("gateway"),
    },
    models: [...MODELS, ...(local ? [local] : []), ...gatewayProfiles()],
    history: history(),
    localAvailable: !!local,
    localModel: local?.name ?? null,
    localQualityReady:
      !!local &&
      Object.values(local.qualitySampleCounts ?? {}).length === 4 &&
      Object.values(local.qualitySampleCounts!).every((n) => n > 0),
    gatewayAvailable: !!pool,
    gatewayPool: pool?.label ?? null,
    defaultInput,
  };
}
export function previewRequest(
  input: RequestInput,
  settings = getSettings(),
): Preview {
  if (!settings.users.some((u) => u.id === input.userId))
    throw new AppError("Choose a user who belongs to this workspace.");
  if (input.mode === "local" && !process.env.OLLAMA_MODEL)
    throw new AppError(
      "Local inference is not configured. Simulation works without setup.",
    );
  const pool = gatewayPool();
  if (input.mode === "gateway" && !pool)
    throw new AppError(
      "Gateway mode is not configured. Set ORCHESTRA_POOL and LITELLM_MASTER_KEY in .env.local, start LiteLLM, and restart Orchestra.",
    );
  const start = performance.now();
  const local = localProfile(allRecords());
  const context = budgetContext(settings, input);
  // Local accounting uses real UTC calendar dates, never the simulation date or opening balance.
  const effective =
    input.mode === "local"
      ? {
          ...settings,
          simulatedDate: new Date().toISOString().slice(0, 10),
          openingSpend: 0,
        }
      : settings;
  const classification =
    input.importanceMode === "inferred"
      ? classifyTask(input.prompt)
      : undefined;
  // Resolve once before routing; keep the evaluated policy math unchanged.
  const resolvedInput: RequestInput = classification
    ? {
        ...input,
        importance: classification.importance,
        importanceMode: "fixed",
      }
    : input;
  const result = buildPreview(
    resolvedInput,
    effective,
    [...MODELS, ...(local ? [local] : []), ...gatewayProfiles()],
    context,
  );
  if (input.mode === "gateway" && pool)
    result.policy.assumptions.push(...gatewayAssumptions(pool));
  if (input.mode === "local") {
    result.policy.assumptions.push(
      "Local inference has no API charge; electricity and hardware costs are excluded.",
      "Uncalibrated task quality is 0 (unknown). Use floor 0 to gather calibration responses, then rate them in History.",
    );
    if (
      local?.quality[input.task] === 0 &&
      input.qualityFloor > 0 &&
      result.selected
    ) {
      result.selected = null;
      result.candidates.forEach((c) => {
        if (c.model.local) {
          c.eligible = false;
          c.reasons.push(
            "No positive measured quality estimate for this task.",
          );
          c.score = null;
        }
      });
    }
  }
  if (classification) result.classification = classification;
  if (!result.selected) {
    const reasons = [
      ...new Set(
        result.candidates
          .filter((candidate) =>
            input.mode === "gateway"
              ? candidate.model.gateway
              : !candidate.model.gateway &&
                candidate.model.local === (input.mode === "local"),
          )
          .flatMap((candidate) => candidate.reasons),
      ),
    ];
    result.rejectionReason = `No model meets the current policy (${result.policy.importance} importance, ${Math.round(result.policy.qualityFloor * 100)}% quality floor, $${result.policy.maxCostPerRequest.toFixed(6)} request allowance). ${reasons.join(" ") || "No models are available in this execution mode."} Review the budget or request guardrails.`;
  }
  result.routingMs = performance.now() - start;
  return result;
}
export async function runRequest(
  input: RequestInput,
  key: string,
): Promise<RunRecord> {
  const prepared = transaction(() => {
    const existing = findKey(key, input);
    if (existing) return { existing };
    const settings = getSettings(),
      preview = previewRequest(input, settings);
    const meta = reserve(key, input, settings, preview);
    const record: RunRecord = {
      ...meta,
      input: { ...input, importance: preview.policy.importance },
      preview,
      status: preview.selected ? "completed" : "rejected",
      response: "",
      simulatedCost: 0,
      actualCost: 0,
      simulatedLatency: null,
      measuredLatencyMs: null,
      inputTokens: 0,
      outputTokens: 0,
      rating: null,
      error: null,
    };
    if (!preview.selected) {
      record.error = preview.rejectionReason!;
      saveRecord(record);
      return { existing: record };
    }
    if (input.mode === "simulation") {
      const selected = preview.selected;
      record.simulatedCost = selected.estimatedCost;
      record.simulatedLatency = selected.estimatedLatency;
      record.inputTokens = selected.inputTokens;
      record.outputTokens = selected.outputTokens;
      record.response = `SIMULATED EXECUTION — no language model was called.\n\n${selected.model.name} was selected for your ${input.task} request.\n\nRequest: ${input.prompt}\n\nThis placeholder demonstrates the routing workflow; it is not an answer to your prompt. The simulation assumes ${selected.outputTokens} output tokens, ${selected.estimatedLatency.toFixed(1)} seconds, and an illustrative quality score of ${(selected.estimatedQuality * 100).toFixed(0)}%.\n\nThe simulated ledger was updated by $${selected.estimatedCost.toFixed(6)}. Actual API charges: $0. Configure local inference to generate a real answer without a paid API.`;
      saveRecord(record);
      return { existing: record };
    }
    return { record };
  });
  if (prepared.existing) return prepared.existing;
  const record = prepared.record!;
  if (input.mode === "gateway") {
    try {
      Object.assign(
        record,
        await generateGateway(
          input,
          record.preview.selected!,
          record.preview.policy.budget.remaining,
        ),
      );
    } catch (error) {
      // Configuration errors are raised before any request is sent.
      record.status = "failed";
      record.error =
        error instanceof Error ? error.message : "Gateway request failed.";
    }
    transaction(() => saveRecord(record));
    return record;
  }
  try {
    const result = await generateLocal(input);
    record.response = result.response;
    record.inputTokens = result.inputTokens;
    record.outputTokens = result.outputTokens;
    record.measuredLatencyMs = result.latencyMs;
  } catch (error) {
    record.status = "failed";
    record.error =
      error instanceof Error ? error.message : "Local inference failed.";
  }
  transaction(() => saveRecord(record));
  return record;
}
export function rateRecord(
  id: string,
  correctness: number,
  completeness: number,
  instructionFollowing: number,
) {
  return transaction(() => {
    const record = getRecord(id);
    if (record.input.mode === "simulation" || record.status !== "completed")
      throw new AppError(
        "Only completed real responses can be rated. Simulation values are illustrative.",
      );
    record.rating = {
      correctness,
      completeness,
      instructionFollowing,
      score: qualityScore({ correctness, completeness, instructionFollowing }),
    };
    saveRecord(record);
    return record;
  });
}
