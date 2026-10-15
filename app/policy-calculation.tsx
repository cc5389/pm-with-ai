import type { Policy } from "@/lib/types";

const dollars = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(value) >= 1 ? 2 : 8,
  }).format(value);
const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 4 });
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/** Render the stored calculation only, including for historical records. */
export function PolicyCalculationDetails({ policy }: { policy: Policy }) {
  const c = policy.calculation;
  if (!c)
    return (
      <p className="helper">
        This historical v{policy.version} policy has no calculation trace. Its
        original values are shown above.
      </p>
    );
  const b = policy.budget;
  const unchangedAllowance = c.importanceComparison.every(
    (row) =>
      Math.abs(row.allowance - c.importanceComparison[0].allowance) <= 1e-12,
  );
  return (
    <section
      className="calculation-details"
      aria-label="Agent1 live calculation"
    >
      <h3>How this policy is calculated</h3>
      <p className="importance-summary">
        <strong className="capitalize">
          {policy.importance} importance · {number(c.multiplier)}×
        </strong>
        <br />
        Extra allowance and quality preference; quality floor stays at{" "}
        {percent(policy.qualityFloor)}.
      </p>
      <div className="table-scroll">
        <table className="math-table importance-comparison">
          <caption>Compare importance · same request and budget</caption>
          <thead>
            <tr>
              <th>Importance</th>
              <th>Allowance</th>
              <th>Quality</th>
              <th>Cost</th>
              <th>Latency</th>
            </tr>
          </thead>
          <tbody>
            {c.importanceComparison.map((row) => (
              <tr
                key={row.importance}
                aria-current={
                  row.importance === policy.importance ? "true" : undefined
                }
              >
                <th scope="row" className="capitalize">
                  {row.importance} · {number(row.multiplier)}×
                  {row.importance === policy.importance ? " (selected)" : ""}
                </th>
                <td>{dollars(row.allowance)}</td>
                <td>{percent(row.weights.quality)}</td>
                <td>{percent(row.weights.cost)}</td>
                <td>{percent(row.weights.latency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unchangedAllowance && (
        <p className="helper">
          The allowance is unchanged across importance levels. Current binding
          limits: {c.bindingLimits.join(", ")}. Equal multipliers can also
          produce equal allowances.
        </p>
      )}
      <ol className="calculation-steps">
        <li>
          <strong>Funds available</strong>
          <p>
            {dollars(b.monthlyBudget)} budget − {dollars(b.spent)} spent −{" "}
            {dollars(b.reserved)} reserved = <b>{dollars(b.remaining)}</b>{" "}
            remaining, floored at zero.
          </p>
        </li>
        <li>
          <strong>Forecast</strong>
          <p>
            {number(c.daysLeft)} of {number(b.daysInMonth)} days left ·{" "}
            {number(c.completedRequests)} completed requests.
          </p>
          <p>
            Configured requests left: {number(c.configuredRemaining)}.
            {c.observedRemaining === null
              ? " Fewer than 20 completions: use configured volume."
              : ` Observed estimate: ${number(c.observedRemaining)}; use the larger estimate.`}{" "}
            Result: <b>{number(b.expectedRemainingRequests)}</b>.
          </p>
          <p>
            {c.coldStart
              ? `Cold start: supplied full-month estimate = ${dollars(b.projectedSpend)}.`
              : `Spend forecast: ${dollars(b.spent)} + ${dollars(b.spent)} ÷ max(${number(b.elapsedDays)}, 1) × ${number(c.daysLeft)} = ${dollars(b.projectedSpend)}.`}
          </p>
        </li>
        <li>
          <strong>Budget pressure</strong>
          {b.monthlyBudget <= 0 ? (
            <p>
              Company budget is zero: pressure = 100%; requests are rejected.
            </p>
          ) : (
            <>
              <p>
                Projected overspending: clip({dollars(b.projectedSpend)} ÷{" "}
                {dollars(b.monthlyBudget)} − 1) ={" "}
                {percent(c.projectionPressure)}.
              </p>
              <p>
                Low balance: clip(1 − {dollars(b.remaining)} ÷ (
                {percent(c.rules.lowBalanceThreshold)} ×{" "}
                {dollars(b.monthlyBudget)})) = {percent(c.lowBalancePressure)}.
              </p>
              <p>
                Take the larger value: <b>{percent(b.pressure)}</b>. Clip keeps
                each component between 0% and 100%.
              </p>
            </>
          )}
        </li>
        <li>
          <strong>Adjust and normalize preferences</strong>
          <p>
            Quality × {number(c.multiplier)}; cost +{" "}
            {number(c.rules.costPressureStrength)} × {percent(b.pressure)};
            latency unchanged. Divide each result by their sum.
          </p>
          <div className="table-scroll">
            <table className="math-table">
              <caption>Preference calculation</caption>
              <thead>
                <tr>
                  <th>Preference</th>
                  <th>Base</th>
                  <th>Adjusted</th>
                  <th>Normalized</th>
                </tr>
              </thead>
              <tbody>
                {(["quality", "cost", "latency"] as const).map((key) => (
                  <tr key={key}>
                    <th className="capitalize" scope="row">
                      {key}
                    </th>
                    <td>{number(c.baseWeights[key])}</td>
                    <td>{number(c.adjustedWeights[key])}</td>
                    <td>{percent(policy.weights[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {c.baseWeights.quality === 0 && (
            <p className="helper">
              Your base quality preference is zero, so importance cannot
              increase its weight. The quality floor still applies.
            </p>
          )}
          {Object.values(c.adjustedWeights).every((value) => value === 0) && (
            <p className="helper">
              All adjusted weights are zero; use the quality-only fallback
              (100%, 0%, 0%).
            </p>
          )}
        </li>
        <li>
          <strong>Set the request allowance</strong>
          <p>
            {dollars(b.remaining)} ÷ max({number(b.expectedRemainingRequests)},
            1) = {dollars(c.baseAllowance)} base; × {number(c.multiplier)}{" "}
            importance = <b>{dollars(c.teamAllowance)}</b> team allowance.
          </p>
          {c.userAllowance !== null && (
            <p>
              User allowance: {dollars(b.userRemaining!)} ÷ max(expected
              requests left ÷ team members, 1) × {number(c.multiplier)} ={" "}
              {dollars(c.userAllowance)}. Future usage is shared equally.
            </p>
          )}
          <ul className="allowance-limits">
            {c.allowanceLimits.map((limit) => (
              <li key={limit.name}>
                {limit.name}: {dollars(limit.amount)}
                {c.bindingLimits.includes(limit.name) ? " · binding limit" : ""}
              </li>
            ))}
          </ul>
          <p>
            Take the minimum: <b>{dollars(policy.maxCostPerRequest)}</b>.
            Binding {c.bindingLimits.length === 1 ? "limit" : "limits"}:{" "}
            {c.bindingLimits.join(", ")}.
          </p>
        </li>
      </ol>
      <p className="helper">
        Displayed numbers are rounded; calculations use full precision. Higher
        importance cannot override limits. Normalized weights can stay equal
        when only one preference is active. Marking every request High can use
        up funds earlier.
      </p>
    </section>
  );
}
