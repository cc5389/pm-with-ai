import type { RouterResult } from "../stage-a/adapters/base";

export interface RouterMetrics {
  router: string;
  totalRequests: number;
  successfulRequests: number;
  successRate: number;

  averageCostUsd: number | null;
  totalCostUsd: number | null;

  averageLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const weight = index - lower;

  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function calculateRouterMetrics(
  router: string,
  results: RouterResult[],
): RouterMetrics {
  const successful = results.filter((result) => result.success);

  const costs = successful
    .map((result) => result.costUsd)
    .filter((value): value is number => value !== null);

  const latencies = successful.map((result) => result.latencyMs);

  return {
    router,
    totalRequests: results.length,
    successfulRequests: successful.length,
    successRate:
      results.length > 0 ? successful.length / results.length : 0,

    averageCostUsd:
      costs.length > 0
        ? costs.reduce((sum, value) => sum + value, 0) / costs.length
        : null,

    totalCostUsd:
      costs.length > 0
        ? costs.reduce((sum, value) => sum + value, 0)
        : null,

    averageLatencyMs:
      latencies.length > 0
        ? latencies.reduce((sum, value) => sum + value, 0) /
          latencies.length
        : null,

    p50LatencyMs: quantile(latencies, 0.5),
    p95LatencyMs: quantile(latencies, 0.95),
  };
}
