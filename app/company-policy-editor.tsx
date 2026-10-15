"use client";

import { useEffect, useState } from "react";
import { DEFAULT_COMPANY_POLICY } from "@/lib/policy";
import { companyPolicySchema } from "@/lib/validation";
import type { CompanyPolicyRules } from "@/lib/types";

const fieldsOf = (rules: CompanyPolicyRules) => ({
  lowBalanceThreshold: String(
    Number((rules.lowBalanceThreshold * 100).toFixed(6)),
  ),
  costPressureStrength: String(rules.costPressureStrength),
  mediumMultiplier: String(rules.mediumMultiplier),
  highMultiplier: String(rules.highMultiplier),
});
const controls = [
  {
    key: "lowBalanceThreshold",
    label: "Low-balance threshold (%)",
    min: 5,
    max: 50,
    step: 1,
    help: "Start adding pressure when remaining company funds fall below this percentage.",
  },
  {
    key: "costPressureStrength",
    label: "Cost pressure strength",
    min: 0,
    max: 5,
    step: 0.1,
    help: "How strongly budget pressure increases the cost preference. Zero disables this weight adjustment.",
  },
  {
    key: "mediumMultiplier",
    label: "Medium importance multiplier",
    min: 1,
    max: 3,
    step: 0.1,
    help: "Multiply both the base allowance and quality preference by this amount.",
  },
  {
    key: "highMultiplier",
    label: "High importance multiplier",
    min: 1,
    max: 3,
    step: 0.1,
    help: "At least the Medium multiplier. Low importance always uses 1×.",
  },
] as const;

export function CompanyPolicyEditor({
  rules,
  onChange,
  onSave,
  dirty,
  disabled,
  error,
  saveDisabled,
}: {
  rules: CompanyPolicyRules;
  onChange: (rules: CompanyPolicyRules | null, error: string | null) => void;
  onSave: () => void;
  dirty: boolean;
  disabled: boolean;
  saveDisabled: boolean;
  error: string | null;
}) {
  const [fields, setFields] = useState(() => fieldsOf(rules));
  useEffect(
    () => setFields(fieldsOf(rules)),
    [
      rules.lowBalanceThreshold,
      rules.costPressureStrength,
      rules.mediumMultiplier,
      rules.highMultiplier,
    ],
  );
  function change(key: keyof typeof fields, value: string) {
    const next = { ...fields, [key]: value };
    setFields(next);
    if (Object.values(next).some((field) => !field.trim())) {
      onChange(
        null,
        "Fill in every company policy setting to calculate a preview.",
      );
      return;
    }
    const parsed = companyPolicySchema.safeParse({
      lowBalanceThreshold: Number(next.lowBalanceThreshold) / 100,
      costPressureStrength: Number(next.costPressureStrength),
      mediumMultiplier: Number(next.mediumMultiplier),
      highMultiplier: Number(next.highMultiplier),
    });
    onChange(
      parsed.success ? parsed.data : null,
      parsed.success
        ? null
        : parsed.error.issues.map((issue) => issue.message).join(" "),
    );
  }
  return (
    <section
      className="panel company-policy-editor"
      aria-label="Company policy settings"
    >
      <div className="panel-heading">
        <h2>Company policy</h2>
        <span className="badge sage">AGENT 01 RULES</span>
      </div>
      <div className="panel-body">
        <p className="helper">
          Choose how the policy responds to importance and budget pressure.
          Changes preview automatically; save to use them in a run.
        </p>
        <fieldset disabled={disabled} className="company-rule-fields">
          {controls.map((control) => (
            <label key={control.key}>
              {control.label}
              <input
                type="number"
                min={control.min}
                max={control.max}
                step={control.step}
                value={fields[control.key]}
                onChange={(event) => change(control.key, event.target.value)}
              />
              <small>{control.help}</small>
            </label>
          ))}
        </fieldset>
        <div className="live-budget-footer">
          <p
            aria-live="polite"
            className={error ? "budget-error" : "budget-live-status"}
          >
            {error ??
              (dirty
                ? "Unsaved policy · preview only"
                : "Using saved company policy")}
          </p>
          <div className="policy-editor-actions">
            <button
              type="button"
              className="button secondary"
              disabled={disabled}
              onClick={() => {
                setFields(fieldsOf(DEFAULT_COMPANY_POLICY));
                onChange({ ...DEFAULT_COMPANY_POLICY }, null);
              }}
            >
              Reset to defaults
            </button>
            <button
              type="button"
              className="button primary"
              disabled={disabled || !dirty || !!error || saveDisabled}
              onClick={onSave}
            >
              Save company policy
            </button>
          </div>
        </div>
        <p className="helper budget-footnote">
          Low = routine work; Medium = normal business work; High = work worth
          extra spending. Importance never lowers the quality floor or overrides
          spending limits.
        </p>
      </div>
    </section>
  );
}
