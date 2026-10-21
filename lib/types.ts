export type Task = "coding" | "analysis" | "writing" | "qa";
export type Importance = "low" | "medium" | "high";
export type Mode = "simulation" | "local" | "gateway";
export type Weights = { quality: number; cost: number; latency: number };
export type CompanyPolicyRules = {
  lowBalanceThreshold: number;
  costPressureStrength: number;
  mediumMultiplier: number;
  highMultiplier: number;
};
export type User = {
  id: string;
  name: string;
  role: string;
  budget: number | null;
};
export type Settings = {
  companyPolicy?: CompanyPolicyRules;
  teamName: string;
  monthlyBudget: number;
  monthlyRequests: number;
  scenario: "early" | "balanced" | "tight" | "custom";
  simulatedDate: string;
  openingSpend: number;
  users: User[];
  blockedModels: string[];
};
export type RequestInput = {
  prompt: string;
  task: Task;
  importance: Importance;
  userId: string;
  qualityFloor: number;
  latencyTarget: number;
  strictLatency: boolean;
  maxRequestCost: number | null;
  outputTokens: number;
  weights: Weights;
  preferredModels: string[];
  blockedModels: string[];
  localOnly: boolean;
  mode: Mode;
};
export type ModelProfile = {
  id: string;
  name: string;
  provider: string;
  tier: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  quality: Record<Task, number>;
  latency: Record<Task, number>;
  source: "illustrative" | "measured";
  measuredAt: string | null;
  sampleCount: number;
  qualitySampleCounts?: Record<Task, number>;
  local: boolean;
  /** Served through the LiteLLM gateway; only eligible in gateway mode. */
  gateway?: boolean;
};
export type BudgetSnapshot = {
  monthlyBudget: number;
  spent: number;
  reserved: number;
  remaining: number;
  utilization: number;
  projectedSpend: number;
  elapsedDays: number;
  daysInMonth: number;
  expectedRemainingRequests: number;
  pressure: number;
  requestAllowance: number;
  userRemaining: number | null;
};
export type Policy = {
  version: "1.0" | "1.1";
  calculation?: PolicyCalculation;
  task: Task;
  importance: Importance;
  weights: Weights;
  qualityFloor: number;
  latencyTarget: number;
  strictLatency: boolean;
  maxCostPerRequest: number;
  allowedModels: string[];
  budget: BudgetSnapshot;
  reasons: string[];
  assumptions: string[];
};
export type ImportanceComparison = {
  importance: Importance;
  multiplier: number;
  allowance: number;
  weights: Weights;
  bindingLimits: string[];
};
export type PolicyCalculation = {
  rules: CompanyPolicyRules;
  multiplier: number;
  baseWeights: Weights;
  adjustedWeights: Weights;
  daysLeft: number;
  completedRequests: number;
  coldStart: boolean;
  configuredRemaining: number;
  observedRemaining: number | null;
  projectionPressure: number;
  lowBalancePressure: number;
  baseAllowance: number;
  teamAllowance: number;
  userAllowance: number | null;
  allowanceLimits: { name: string; amount: number }[];
  bindingLimits: string[];
  importanceComparison: ImportanceComparison[];
};
export type Candidate = {
  model: ModelProfile;
  estimatedCost: number;
  estimatedQuality: number;
  estimatedLatency: number;
  inputTokens: number;
  outputTokens: number;
  eligible: boolean;
  reasons: string[];
  score: number | null;
  preferred: boolean;
};
export type Preview = {
  policy: Policy;
  candidates: Candidate[];
  selected: Candidate | null;
  routingMs: number;
};
export type Rating = {
  correctness: number;
  completeness: number;
  instructionFollowing: number;
  score: number;
};
export type RunRecord = {
  id: string;
  createdAt: string;
  month: string;
  input: RequestInput;
  preview: Preview;
  status: "completed" | "rejected" | "failed";
  response: string;
  simulatedCost: number;
  actualCost: number;
  simulatedLatency: number | null;
  measuredLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  rating: Rating | null;
  error: string | null;
  /** Present on gateway runs. */
  gateway?: {
    pool: string;
    /** Costs are shadow prices; nothing was billed. */
    shadowPriced: boolean;
    requestedModel: string;
    returnedModel: string | null;
    costBasis: "actual" | "estimated" | "none" | "unresolved";
    reservedCost: number;
    attempts: number;
  };
};
export type Workspace = {
  settings: Settings;
  models: ModelProfile[];
  history: RunRecord[];
  balances: Record<
    Mode,
    { spent: number; reserved: number; remaining: number }
  >;
  localAvailable: boolean;
  localModel: string | null;
  localQualityReady: boolean;
  gatewayAvailable: boolean;
  gatewayPool: string | null;
};
export type BudgetContext = {
  spent: number;
  reserved: number;
  userSpent: number;
  userReserved: number;
  completedRequests: number;
};
export type BenchmarkPrompt = {
  id: string;
  task: Task;
  split: "calibration" | "evaluation";
  prompt: string;
  rubric: string;
};
export type EvaluationRow = {
  strategy: "strongest" | "cheapest" | "fixed" | "adaptive";
  submitted: number;
  completed: number;
  completionRate: number;
  totalCost: number;
  averageCost: number;
  meanQuality: number | null;
  qualityPassRate: number | null;
  constraintSatisfactionRate: number;
  p50Latency: number | null;
  p95Latency: number | null;
  routingOverheadMs: number;
  savings: number | null;
  modelCounts: Record<string, number>;
  qualityOverTime: (number | null)[];
};
export type EvaluationResult = {
  mode: "simulation";
  scenario: string;
  sampleCount: number;
  qualitySampleCounts?: Record<Task, number>;
  rows: EvaluationRow[];
  caveat: string;
};
