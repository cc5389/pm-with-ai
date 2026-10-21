import { derivePolicy } from "./policy";
import type {
  BudgetContext,
  Candidate,
  ModelProfile,
  Preview,
  RequestInput,
  Settings,
  Task,
} from "./types";

const clip = (value: number, low = 0, high = 1) =>
  Math.min(high, Math.max(low, value));
const positive = (value: number) =>
  Number.isFinite(value) ? Math.max(value, 0) : 0;
/** Agent 1 creates the policy; Agent 2 filters and ranks the supplied catalog. No calls or actuation. */
export function buildPreview(
  input: RequestInput,
  settings: Settings,
  models: ModelProfile[],
  context: BudgetContext,
): Preview {
  const inputTokens = Math.max(1, Math.ceil(input.prompt.length / 4));
  const outputTokens = Math.ceil(positive(input.outputTokens));
  const costFor = (m: ModelProfile) =>
    (inputTokens * positive(m.inputPrice) +
      outputTokens * positive(m.outputPrice)) /
    1e6;
  const servesMode = (m: ModelProfile) =>
    input.mode === "gateway"
      ? !!m.gateway
      : !m.gateway && (input.mode === "local" ? m.local : !m.local);
  const inMode = models.filter(servesMode);
  const seededAverageCost = inMode.length
    ? inMode.reduce((sum, m) => sum + costFor(m), 0) / inMode.length
    : 0;
  const policy = derivePolicy(
    input,
    settings,
    context,
    Math.max(0, settings.monthlyRequests) * seededAverageCost,
  );
  const { monthlyBudget, remaining, userRemaining } = policy.budget;
  const requestAllowance = policy.maxCostPerRequest;
  const weights = policy.weights;
  const user = settings.users.find((u) => u.id === input.userId);
  const blocked = new Set([...settings.blockedModels, ...input.blockedModels]);
  const candidates: Candidate[] = models.map((model) => {
    const estimatedCost = costFor(model),
      estimatedQuality = clip(positive(model.quality[input.task]));
    const estimatedLatency = positive(model.latency[input.task]);
    const reasons: string[] = [];
    if (monthlyBudget <= 0) reasons.push("Monthly budget is zero.");
    else if (remaining <= 0)
      reasons.push("The team's monthly budget is exhausted or reserved.");
    if (!user) reasons.push("The selected user is not part of this team.");
    if (userRemaining !== null && userRemaining <= 0)
      reasons.push("The user's monthly budget is exhausted or reserved.");
    if (blocked.has(model.id))
      reasons.push("Blocked by team or request settings.");
    if (input.mode === "gateway" && !model.gateway)
      reasons.push("Gateway execution requires a model configured in LiteLLM.");
    else if (input.mode !== "gateway" && model.gateway)
      reasons.push("This model runs only through the LiteLLM gateway.");
    else if (input.mode === "local" && !model.local)
      reasons.push("Local execution requires a local model.");
    else if (input.mode === "simulation" && model.local)
      reasons.push("Simulation uses illustrative cloud profiles.");
    if (input.localOnly && !model.local)
      reasons.push("Privacy setting requires a local model.");
    if (inputTokens + outputTokens > positive(model.contextWindow))
      reasons.push("Estimated input and output exceed the context window.");
    if (estimatedQuality < input.qualityFloor)
      reasons.push("Estimated task quality is below the required floor.");
    if (estimatedCost > requestAllowance + 1e-12)
      reasons.push("Estimated cost exceeds this request's allowance.");
    if (input.strictLatency && estimatedLatency > input.latencyTarget)
      reasons.push("Estimated latency exceeds the strict target.");
    const costPenalty =
      requestAllowance > 0
        ? clip(estimatedCost / requestAllowance)
        : estimatedCost === 0
          ? 0
          : 1;
    const latencyPenalty =
      input.latencyTarget > 0
        ? clip(estimatedLatency / input.latencyTarget, 0, 2)
        : estimatedLatency === 0
          ? 0
          : 2;
    const eligible = reasons.length === 0;
    return {
      model,
      estimatedCost,
      estimatedQuality,
      estimatedLatency,
      inputTokens,
      outputTokens,
      eligible,
      reasons,
      score: eligible
        ? weights.quality * estimatedQuality -
          weights.cost * costPenalty -
          weights.latency * latencyPenalty
        : null,
      preferred: input.preferredModels.includes(model.id),
    };
  });
  const ranked = candidates
    .filter((c) => c.eligible)
    .sort(
      (a, b) =>
        b.score! - a.score! ||
        Number(b.preferred) - Number(a.preferred) ||
        a.estimatedCost - b.estimatedCost ||
        a.model.id.localeCompare(b.model.id, "en"),
    );
  const selected = ranked[0] ?? null;
  return {
    policy: {
      ...policy,
      allowedModels: ranked.map((c) => c.model.id),
      reasons: [
        ...policy.reasons,
        selected
          ? `${selected.model.name} has the highest eligible score; preferences only resolve score ties.`
          : "No model satisfies every hard constraint; the request is rejected without relaxing the policy.",
      ],
      assumptions: [
        ...policy.assumptions,
        "Input tokens are estimated as one token per four characters. Output uses the requested token allowance.",
        ...(input.mode === "gateway"
          ? []
          : [
              "Cloud prices, quality, and latency are fictional illustrative profiles, not measured vendor performance.",
            ]),
        ...(policy.calculation.coldStart
          ? [
              "Cold-start projection uses configured monthly volume and the mean estimated cost of profiles in the execution mode.",
            ]
          : []),
      ],
    },
    candidates,
    selected,
    routingMs: 0,
  };
}

export function suggestTask(prompt: string): Task {
  if (
    /\b(code|coding|function|typescript|javascript|python|sql|debug|algorithm|unit test|implement|refactor)\b/i.test(
      prompt,
    )
  )
    return "coding";
  if (
    /\b(analy[sz]e|analysis|compare|tradeoffs?|evaluate|strategy|risks?|recommend|forecast|assess)\b/i.test(
      prompt,
    )
  )
    return "analysis";
  if (
    /\b(write|draft|rewrite|email|story|article|copy|tone|blog|poem|headline)\b/i.test(
      prompt,
    )
  )
    return "writing";
  return "qa";
}
/** Three equally weighted human rubric dimensions, each scored 1–5. */
export function qualityScore(ratings: {
  correctness: number;
  completeness: number;
  instructionFollowing: number;
}): number {
  const values = [
    ratings.correctness,
    ratings.completeness,
    ratings.instructionFollowing,
  ];
  if (values.some((v) => !Number.isFinite(v) || v < 1 || v > 5))
    throw new Error("Each rating must be between 1 and 5.");
  return (values.reduce((sum, v) => sum + v, 0) / 3 - 1) / 4;
}
