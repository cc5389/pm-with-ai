"use client";
import { useEffect, useState } from "react";
import { Check, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { settingsSchema } from "@/lib/validation";
import type { Settings } from "@/lib/types";
type Fields = {
  monthlyBudget: string;
  openingSpend: string;
  monthlyRequests: string;
  simulatedDate: string;
};
const fieldsOf = (s: Settings): Fields => ({
  monthlyBudget: String(s.monthlyBudget),
  openingSpend: String(s.openingSpend),
  monthlyRequests: String(s.monthlyRequests),
  simulatedDate: s.simulatedDate,
});
export function BudgetEditor({
  settings,
  onChange,
  onSave,
  dirty,
  disabled,
  calculating,
  error,
}: {
  settings: Settings;
  onChange: (settings: Settings | null, error: string | null) => void;
  onSave: () => void;
  dirty: boolean;
  disabled: boolean;
  calculating: boolean;
  error: string | null;
}) {
  const [fields, setFields] = useState(() => fieldsOf(settings));
  useEffect(() => setFields(fieldsOf(settings)), [settings]);
  function change(key: keyof Fields, value: string) {
    const next = { ...fields, [key]: value };
    setFields(next);
    if (Object.values(next).some((v) => !v.trim())) {
      onChange(
        null,
        "Fill in all four budget fields to calculate your policy.",
      );
      return;
    }
    const parsed = settingsSchema.safeParse({
      ...settings,
      scenario: "custom",
      monthlyBudget: Number(next.monthlyBudget),
      openingSpend: Number(next.openingSpend),
      monthlyRequests: Number(next.monthlyRequests),
      simulatedDate: next.simulatedDate,
    });
    if (!parsed.success) {
      onChange(
        null,
        "Use nonnegative budget and spend, a valid date, and a positive whole number of monthly requests.",
      );
      return;
    }
    onChange(parsed.data, null);
  }
  return (
    <section
      className="panel live-budget-panel"
      aria-label="Live budget calculator"
    >
      <div className="panel-heading">
        <div>
          <SlidersHorizontal size={18} />
          <h2>Your budget</h2>
        </div>
        <span className="badge sage">LIVE CALCULATOR</span>
      </div>
      <div className="panel-body">
        <p className="helper">
          Enter your numbers. The balance, forecast, policy, and model selection
          update automatically.
        </p>
        <fieldset disabled={disabled} className="live-budget-fields">
          <label>
            Monthly budget ($)
            <input
              type="number"
              min="0"
              max="1000000000"
              step="0.01"
              inputMode="decimal"
              value={fields.monthlyBudget}
              onChange={(e) => change("monthlyBudget", e.target.value)}
            />
          </label>
          <label>
            Starting spend this month ($)
            <input
              type="number"
              min="0"
              max="1000000000"
              step="0.01"
              inputMode="decimal"
              value={fields.openingSpend}
              onChange={(e) => change("openingSpend", e.target.value)}
            />
          </label>
          <label>
            As-of date
            <input
              type="date"
              value={fields.simulatedDate}
              onChange={(e) => change("simulatedDate", e.target.value)}
            />
          </label>
          <label>
            Expected requests / month
            <input
              type="number"
              min="1"
              max="10000000"
              step="1"
              inputMode="numeric"
              value={fields.monthlyRequests}
              onChange={(e) => change("monthlyRequests", e.target.value)}
            />
          </label>
        </fieldset>
        <div className="live-budget-footer">
          <div
            aria-live="polite"
            className={error ? "budget-error" : "budget-live-status"}
          >
            {error ? (
              error
            ) : calculating ? (
              <>
                <LoaderCircle size={14} className="spin" />
                Updating calculations…
              </>
            ) : dirty ? (
              <>
                <Check size={14} />
                Preview updated · unsaved budget
              </>
            ) : (
              <>
                <Check size={14} />
                Using saved budget · updates automatically
              </>
            )}
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={disabled || !dirty || !!error}
            onClick={onSave}
          >
            Save budget
          </button>
        </div>
        <p className="helper budget-footnote">
          Starting spend is your balance before recorded runs; new simulation
          costs are added to it. Editing these fields creates a custom scenario.
          Save budget keeps your numbers for next time; running a request also
          saves them. Previews never record spending.
        </p>
      </div>
    </section>
  );
}
