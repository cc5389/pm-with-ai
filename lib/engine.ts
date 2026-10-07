import type {
  BudgetContext,
  Candidate,
  ModelProfile,
  Preview,
  RequestInput,
  Settings,
  Task,
  Weights,
} from "./types";

const clip = (value: number, low = 0, high = 1) =>
  Math.min(high, Math.max(low, value));
const positive = (value: number) =>
  Number.isFinite(value) ? Math.max(value, 0) : 0;
const importance = { low: 0, medium: 0.5, high: 1 } as const;
const DAY = 86400000;

function monthClock(value: string) {
  // A calendar-only date means noon UTC, never the host's local timezone.
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : value,
  );
  if (!Number.isFinite(date.getTime()))
    throw new Error("The simulated date must be a valid ISO date.");
  const year = date.getUTCFullYear(),
    month = date.getUTCMonth();
  const start = Date.UTC(year, month, 1),
    next = Date.UTC(year, month + 1, 1);
  return {
    daysInMonth: (next - start) / DAY,
    elapsedDays: clip((date.getTime() - start) / DAY, 0, (next - start) / DAY),
  };
}
function normalize(weights: Weights): Weights {
  const quality = positive(weights.quality),
    cost = positive(weights.cost),
    latency = positive(weights.latency);
  const total = quality + cost + latency;
  return total > 0
    ? { quality: quality / total, cost: cost / total, latency: latency / total }
    : { quality: 1, cost: 0, latency: 0 };
}

/** Agent 1 creates the policy; Agent 2 filters and ranks the supplied catalog. No calls or actuation. */
export function buildPreview(
  input: RequestInput,
  settings: Settings,
  models: ModelProfile[],
  context: BudgetContext,
): Preview {
  const { daysInMonth, elapsedDays } = monthClock(settings.simulatedDate);
  const monthlyBudget = positive(settings.monthlyBudget),
    spent = positive(context.spent),
    reserved = positive(context.reserved);
  const remaining = Math.max(monthlyBudget - spent - reserved, 0);
  const completed = positive(context.completedRequests),
    volume = positive(settings.monthlyRequests);
  const daysLeft = Math.max(daysInMonth - elapsedDays, 0);
  const inputTokens = Math.max(1, Math.ceil(input.prompt.length / 4));
  const outputTokens = Math.ceil(positive(input.outputTokens));
  const costFor = (m: ModelProfile) =>
    (inputTokens * positive(m.inputPrice) +
      outputTokens * positive(m.outputPrice)) /
    1e6;
  const inMode = models.filter((m) =>
    input.mode === "local" ? m.local : !m.local,
  );
  const seededAverageCost = inMode.length
    ? inMode.reduce((sum, m) => sum + costFor(m), 0) / inMode.length
    : 0;
  const coldStart = spent === 0 && completed === 0;
  const projectedSpend = coldStart
    ? volume * seededAverageCost
    : spent + (spent / Math.max(elapsedDays, 1)) * daysLeft;
  const configuredRemaining = (volume * daysLeft) / daysInMonth;
  const expectedRemainingRequests =
    completed >= 20
      ? Math.max(
          configuredRemaining,
          (completed / Math.max(elapsedDays, 1)) * daysLeft,
        )
      : configuredRemaining;
  const pressure =
    monthlyBudget > 0
      ? Math.max(
          clip(projectedSpend / monthlyBudget - 1),
          clip(1 - remaining / (0.2 * monthlyBudget)),
        )
      : 1;
  const i = importance[input.importance];
  const weights = normalize({
    quality: positive(input.weights.quality) * (1 + i),
    cost: positive(input.weights.cost) + 2 * pressure,
    latency: positive(input.weights.latency),
  });
  const user = settings.users.find((u) => u.id === input.userId);
  const userRemaining =
    user?.budget == null
      ? null
      : Math.max(
          positive(user.budget) -
            positive(context.userSpent) -
            positive(context.userReserved),
          0,
        );
  const requestAllowance = Math.min(
    remaining,
    input.maxRequestCost == null ? Infinity : positive(input.maxRequestCost),
    (remaining / Math.max(expectedRemainingRequests, 1)) * (1 + i),
    userRemaining ?? Infinity,
    userRemaining === null
      ? Infinity
      : (userRemaining /
          Math.max(
            expectedRemainingRequests / Math.max(settings.users.length, 1),
            1,
          )) *
          (1 + i),
  );
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
    if (input.mode === "local" && !model.local)
      reasons.push("Local execution requires a local model.");
    if (input.mode === "simulation" && model.local)
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
  const reasons = [
    `Budget pressure is ${(pressure * 100).toFixed(1)}%; quality, cost, and latency weights were normalized after adapting to importance and pressure.`,
    `Allowance shares $${remaining.toFixed(2)} across approximately ${Math.ceil(expectedRemainingRequests)} remaining requests, with a ${(1 + i).toFixed(1)}× importance factor.`,
    selected
      ? `${selected.model.name} has the highest eligible score; preferences only resolve score ties.`
      : "No model satisfies every hard constraint; the request is rejected without relaxing the policy.",
  ];
  return {
    policy: {
      version: "1.0",
      task: input.task,
      importance: input.importance,
      weights,
      qualityFloor: input.qualityFloor,
      latencyTarget: input.latencyTarget,
      strictLatency: input.strictLatency,
      maxCostPerRequest: requestAllowance,
      allowedModels: ranked.map((c) => c.model.id),
      budget: {
        monthlyBudget,
        spent,
        reserved,
        remaining,
        utilization: monthlyBudget > 0 ? spent / monthlyBudget : 0,
        projectedSpend,
        elapsedDays,
        daysInMonth,
        expectedRemainingRequests,
        pressure,
        requestAllowance,
        userRemaining,
      },
      reasons,
      assumptions: [
        "Input tokens are estimated as one token per four characters. Output uses the requested token allowance.",
        "Cloud prices, quality, and latency are fictional illustrative profiles, not measured vendor performance.",
        "Costs reserve the full output estimate; quality and latency thresholds apply to estimates, not guarantees.",
        coldStart
          ? "Cold-start projection uses configured monthly volume and the mean estimated cost of profiles in the execution mode."
          : "Projection extrapolates spend to date, including opening spend; reservations reduce remaining funds.",
        completed >= 20
          ? "Remaining volume is the larger of configured prorated volume and observed completed requests per elapsed day; this avoids understating unobserved opening-period traffic."
          : "Fewer than 20 observed completions: remaining volume uses the configured monthly volume prorated over the UTC calendar month.",
        "Optional user budgets assume equal expected request volume across team members and use the same importance factor.",
        "Calendar-only dates use noon UTC. Zero or exhausted team/user budgets reject all requests, including free local runs.",
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
