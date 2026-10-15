"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BudgetEditor } from "./budget-editor";
import { CompanyPolicyEditor } from "./company-policy-editor";
import { PolicyCalculationDetails } from "./policy-calculation";
import { importanceMultiplier, resolveCompanyPolicy } from "@/lib/policy";
import { suggestTask } from "@/lib/engine";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Coins,
  FlaskConical,
  History,
  Layers3,
  LoaderCircle,
  Play,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import type {
  BenchmarkPrompt,
  CompanyPolicyRules,
  EvaluationResult,
  Preview,
  RequestInput,
  RunRecord,
  Settings,
  Workspace,
} from "@/lib/types";

type View = "lab" | "history" | "evaluation" | "workspace";
const money = (value: number, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
const pct = (value: number) => `${Math.round(value * 100)}%`;
const examples = [
  {
    label: "Debug a function",
    task: "coding",
    text: "Review this Python function, explain the bug, and provide a corrected version with a small test:\n\ndef unique_items(items):\n    result = []\n    for item in items:\n        if item not in result:\n            return result.append(item)\n    return result",
  },
  {
    label: "Analyze a decision",
    task: "analysis",
    text: "Our product team has two weeks to improve onboarding. Compare a guided product tour with a simpler signup flow. Recommend an approach, state your assumptions, and propose three measurable success criteria.",
  },
  {
    label: "Write an update",
    task: "writing",
    text: "Write a concise product update announcing a new team analytics dashboard. Keep it friendly and specific. Include a headline, the benefit to team leads, and a clear invitation to try it.",
  },
] as const;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "compact" : ""}`}>
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      {!compact && (
        <span>
          orchestra<span className="brand-dot">.</span>
        </span>
      )}
    </div>
  );
}
function Badge({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Loading({ children = "Working" }: { children?: React.ReactNode }) {
  return (
    <>
      <LoaderCircle size={15} className="spin" />
      {children}
    </>
  );
}

export default function Dashboard() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [input, setInput] = useState<RequestInput | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<RunRecord | null>(null);
  const [view, setView] = useState<View>("lab");
  const [busy, setBusy] = useState<string | null>("init");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [benchmarkPrompts, setBenchmarkPrompts] = useState<BenchmarkPrompt[]>(
    [],
  );
  const [benchmarkFilter, setBenchmarkFilter] = useState<
    "all" | "calibration" | "evaluation"
  >("all");
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<RunRecord | null>(
    null,
  );
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<Settings | null>(null);
  const [budgetDraftError, setBudgetDraftError] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<CompanyPolicyRules | null>(
    null,
  );
  const [policyDraftError, setPolicyDraftError] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [calculationError, setCalculationError] = useState<string | null>(null);
  const [ratings, setRatings] = useState({
    correctness: 4,
    completeness: 4,
    instructionFollowing: 4,
  });
  const activeOperation = useRef(false);
  const policyDirty = !!policyDraftError || !!policyDraft;
  const previewSettings = useMemo(() => {
    const settings = budgetDraft ?? workspace?.settings;
    return settings
      ? {
          ...settings,
          companyPolicy:
            policyDraft ?? resolveCompanyPolicy(workspace!.settings),
        }
      : undefined;
  }, [budgetDraft, workspace, policyDraft]);
  useEffect(() => {
    let active = true;
    api<Workspace & { defaultInput: RequestInput }>("/api/workspace")
      .then(async (data) => {
        if (!active) return;
        setWorkspace(data);
        setDraftSettings(data.settings);
        setInput(data.defaultInput);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (view === "evaluation" && !benchmarkPrompts.length) {
      api<{ prompts: BenchmarkPrompt[] }>("/api/evaluate")
        .then((data) => setBenchmarkPrompts(data.prompts))
        .catch((e) => setError(e.message));
    }
  }, [view, benchmarkPrompts.length]);
  useEffect(() => {
    if (!workspace || !input || busy) return;
    setPreview(null);
    setCalculationError(null);
    if (budgetDraftError || policyDraftError || !input.prompt.trim()) {
      setCalculating(false);
      return;
    }
    let active = true;
    setCalculating(true);
    const timer = setTimeout(() => {
      api<Preview>("/api/preview", {
        input,
        ...(previewSettings ? { settings: previewSettings } : {}),
      })
        .then((data) => {
          if (active) setPreview(data);
        })
        .catch((e) => {
          if (active) setCalculationError(e.message);
        })
        .finally(() => {
          if (active) setCalculating(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    workspace,
    input,
    previewSettings,
    budgetDraftError,
    policyDraftError,
    busy,
  ]);
  function changePolicy(
    rules: CompanyPolicyRules | null,
    message: string | null,
  ) {
    const saved = workspace ? resolveCompanyPolicy(workspace.settings) : null;
    setPolicyDraft(
      rules && JSON.stringify(rules) !== JSON.stringify(saved) ? rules : null,
    );
    setPolicyDraftError(message);
    setPreview(null);
    setResult(null);
    setEvaluation(null);
    setNotice(null);
    setCalculationError(null);
  }
  function changeBudget(settings: Settings | null, message: string | null) {
    setBudgetDraft(settings);
    setBudgetDraftError(message);
    setCalculationError(null);
    setPreview(null);
    setResult(null);
    setEvaluation(null);
    setNotice(null);
  }
  async function persistBudgetDraft() {
    if (!budgetDraft) return;
    const data = await api<Workspace>("/api/workspace", budgetDraft);
    setWorkspace(data);
    setDraftSettings(data.settings);
    setBudgetDraft(null);
    setBudgetDraftError(null);
  }
  function edit(patch: Partial<RequestInput>) {
    if (patch.mode) {
      setBudgetDraft(null);
      setBudgetDraftError(null);
    }
    setInput((current) => (current ? { ...current, ...patch } : current));
    setPreview(null);
    setResult(null);
    setEvaluation(null);
    setNotice(null);
    setError(null);
  }
  async function operate(name: string, action: () => Promise<void>) {
    if (activeOperation.current) return;
    activeOperation.current = true;
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to complete this request.",
      );
    } finally {
      activeOperation.current = false;
      setBusy(null);
    }
  }
  async function saveSettings(
    settings: Settings,
    scenario = false,
    savePolicy = false,
  ) {
    await operate("settings", async () => {
      setPreview(null);
      setResult(null);
      setEvaluation(null);
      const data = await api<Workspace>("/api/workspace", settings);
      setWorkspace(data);
      setDraftSettings(data.settings);
      setBudgetDraft(null);
      setBudgetDraftError(null);
      if (savePolicy) {
        setPolicyDraft(null);
        setPolicyDraftError(null);
      }
      setNotice(
        scenario
          ? "Budget scenario updated. Calculations refresh automatically."
          : "Workspace settings saved.",
      );
    });
  }
  function chooseScenario(scenario: "early" | "balanced" | "tight") {
    if (!workspace) return;
    const fractions = { early: 0.1, balanced: 0.5, tight: 0.92 };
    const dates = {
      early: "2026-10-04",
      balanced: "2026-10-16",
      tight: "2026-10-28",
    };
    void saveSettings(
      {
        ...workspace.settings,
        scenario,
        simulatedDate: dates[scenario],
        openingSpend: workspace.settings.monthlyBudget * fractions[scenario],
      },
      true,
    );
  }
  function toggleModel(key: "preferredModels" | "blockedModels", id: string) {
    if (input)
      edit({
        [key]: input[key].includes(id)
          ? input[key].filter((model) => model !== id)
          : [...input[key], id],
      });
  }
  const navigation: { id: View; label: string; icon: typeof FlaskConical }[] = [
    { id: "lab", label: "Request lab", icon: FlaskConical },
    { id: "history", label: "Run history", icon: History },
    { id: "evaluation", label: "Evaluation", icon: BarChart3 },
    { id: "workspace", label: "Workspace", icon: Settings2 },
  ];
  const balance = workspace && input ? workspace.balances[input.mode] : null;
  const effectiveSettings = previewSettings ?? workspace?.settings;
  const spent = budgetDraft
    ? (preview?.policy.budget.spent ?? budgetDraft.openingSpend)
    : (balance?.spent ?? 0);
  const budget = effectiveSettings?.monthlyBudget || 0;
  const remaining = budgetDraft
    ? (preview?.policy.budget.remaining ?? Math.max(0, budget - spent))
    : (balance?.remaining ?? budget);
  const usage = budget ? spent / budget : 0;
  const titles = {
    lab: "Request lab",
    history: "Run history",
    evaluation: "Routing evaluation",
    workspace: "Workspace settings",
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="workspace-switch">
          <span className="workspace-avatar">S</span>
          <div>
            <strong>
              {workspace?.settings.teamName || "Studio workspace"}
            </strong>
            <small>Team workspace</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              onClick={() => {
                setView(id);
                setError(null);
                setNotice(null);
              }}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "lab" && <span className="nav-new">LAB</span>}
              {id === "history" && !!workspace?.history.length && (
                <span className="nav-count">{workspace.history.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sandbox-card">
            <span className="sandbox-icon">
              <ShieldCheck size={18} />
            </span>
            <strong>A safe space to experiment</strong>
            <p>Explore routing decisions with an illustrative model catalog.</p>
            <span>
              <span className="status-dot" />
              No paid APIs connected
            </span>
          </div>
          <div className="profile">
            <span className="profile-avatar">JD</span>
            <div>
              <strong>Jamie Davis</strong>
              <small>Workspace admin</small>
            </div>
            <Settings2 size={16} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span className="mobile-logo">
              <Logo compact />
            </span>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{titles[view]}</strong>
          </div>
          <div className="topbar-right">
            <Badge tone="sage">
              <span className="status-dot" />
              {input?.mode === "local" ? "Local execution" : "Simulation mode"}
            </Badge>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              aria-label="About this workspace"
              onClick={() =>
                setNotice(
                  "Orchestra is a routing prototype. Catalog quality, token estimates, simulated cost, and latency are illustrative. A local run can record measured timing and human quality ratings.",
                )
              }
            >
              <CircleHelp size={19} />
            </button>
            <span className="tiny-avatar">JD</span>
          </div>
        </header>
        <main>
          {error && (
            <div className="alert error" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError(null)}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="alert success" role="status">
              <span>{notice}</span>
              <button
                aria-label="Dismiss notice"
                onClick={() => setNotice(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!workspace || !input || !draftSettings ? (
            <div className="loading-page">
              <Logo />
              <p>
                {busy ? (
                  <Loading>Preparing your workspace…</Loading>
                ) : (
                  "Workspace unavailable. Refresh the page to reconnect."
                )}
              </p>
            </div>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">INTELLIGENCE, WITH INTENTION</div>
                  <h1>
                    {view === "lab"
                      ? "The right model. Every request."
                      : titles[view]}
                  </h1>
                  <p>
                    {view === "lab"
                      ? "Balance quality, speed, and spend. See the reasoning behind every route."
                      : view === "history"
                        ? "Every decision, response, and cost — in one place."
                        : view === "evaluation"
                          ? "Compare four routing strategies under the same budget and constraints."
                          : "Set the guardrails that shape every routing decision."}
                  </p>
                </div>
                {view === "lab" ? (
                  <div className="heading-note">
                    <span className="orbital-icon">
                      <Layers3 size={22} />
                    </span>
                    <div>
                      <strong>Two agents. One clear decision.</strong>
                      <small>Budget policy → model selection</small>
                    </div>
                  </div>
                ) : (
                  <a className="button secondary" href="/api/export" download>
                    <ArrowDownToLine size={16} />
                    Export workspace
                  </a>
                )}
              </div>
              <div
                className={`company-controls ${input.mode === "local" ? "local-controls" : ""}`}
                hidden={view !== "lab"}
              >
                {input.mode === "simulation" && (
                  <div>
                    <BudgetEditor
                      settings={workspace.settings}
                      onChange={changeBudget}
                      onSave={() => {
                        if (budgetDraft) void saveSettings(budgetDraft);
                      }}
                      dirty={!!budgetDraft}
                      disabled={!!busy}
                      calculating={calculating}
                      error={budgetDraftError || calculationError}
                    />
                  </div>
                )}
                <CompanyPolicyEditor
                  rules={resolveCompanyPolicy(workspace.settings)}
                  onChange={changePolicy}
                  onSave={() => {
                    if (previewSettings && policyDraft && !budgetDraftError)
                      void saveSettings(previewSettings, false, true);
                  }}
                  dirty={policyDirty}
                  disabled={!!busy}
                  saveDisabled={!!budgetDraftError}
                  error={policyDraftError}
                />
              </div>
              <section className="stats-grid" aria-label="Budget overview">
                <div className="stat-card">
                  <div className="stat-label">
                    Monthly budget{" "}
                    <span className="stat-icon">
                      <Coins size={17} />
                    </span>
                  </div>
                  <div className="stat-value">
                    {budgetDraftError ? "—" : money(budget)}
                    <span> / month</span>
                  </div>
                  <div className="stat-bottom">
                    {(input.mode === "local"
                      ? new Date()
                      : new Date(
                          effectiveSettings!.simulatedDate + "T12:00:00Z",
                        )
                    ).toLocaleDateString("en-US", {
                      month: "long",
                      year: "numeric",
                      timeZone: "UTC",
                    })}
                    <span className="soft-label">Team budget</span>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">
                    {input.mode === "simulation"
                      ? "Simulated spend"
                      : "Actual API spend"}{" "}
                    <span className="stat-icon">
                      <Activity size={17} />
                    </span>
                  </div>
                  <div className="stat-value">
                    {budgetDraftError ? "—" : money(spent)}
                    <span className="stat-percentage">{pct(usage)} used</span>
                  </div>
                  <div className="progress-track">
                    <span style={{ width: `${Math.min(100, usage * 100)}%` }} />
                  </div>
                  <div className="stat-footnote">
                    {input.mode === "simulation"
                      ? "Opening balance + this scenario’s runs"
                      : "Actual charges · current UTC month"}
                    {balance && balance.reserved > 0
                      ? ` · ${money(balance.reserved, 5)} reserved`
                      : ""}
                  </div>
                </div>
                <div className="stat-card remaining-card">
                  <div className="stat-label">
                    Budget remaining{" "}
                    <span className="stat-icon">
                      <ShieldCheck size={17} />
                    </span>
                  </div>
                  <div className="stat-value">
                    {budgetDraftError ? "—" : money(remaining)}
                    <span className="remaining-tag">
                      <span className="status-dot" />
                      {usage >= 0.9 ? "Tight budget" : "Within budget"}
                    </span>
                  </div>
                  <div className="stat-bottom">
                    {effectiveSettings!.monthlyRequests.toLocaleString()}{" "}
                    expected requests / month
                    <ArrowUpRight size={15} />
                  </div>
                </div>
              </section>

              {view === "lab" && (
                <>
                  {input.mode === "simulation" && (
                    <div className="scenario-bar">
                      <div>
                        <SlidersHorizontal size={17} />
                        <strong>Try a budget scenario</strong>
                        <span>Watch the policy adapt.</span>
                      </div>
                      <div className="scenario-options">
                        {(
                          [
                            {
                              id: "early",
                              title: "Early month",
                              subtitle: "10% spent",
                            },
                            {
                              id: "balanced",
                              title: "Balanced",
                              subtitle: "50% spent",
                            },
                            {
                              id: "tight",
                              title: "Tight budget",
                              subtitle: "92% spent",
                            },
                          ] as const
                        ).map((s) => (
                          <button
                            key={s.id}
                            disabled={!!busy}
                            aria-pressed={
                              !budgetDraft &&
                              !budgetDraftError &&
                              workspace.settings.scenario === s.id
                            }
                            className={
                              !budgetDraft &&
                              !budgetDraftError &&
                              workspace.settings.scenario === s.id
                                ? "selected"
                                : ""
                            }
                            onClick={() => chooseScenario(s.id)}
                          >
                            {!budgetDraft &&
                              !budgetDraftError &&
                              workspace.settings.scenario === s.id && (
                                <Check size={13} />
                              )}{" "}
                            {s.title}
                            <span>{s.subtitle}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="lab-grid">
                    <section className="panel composer">
                      <div className="panel-heading">
                        <div>
                          <span className="section-icon">
                            <WandSparkles size={18} />
                          </span>
                          <h2>Compose a request</h2>
                        </div>
                        <Badge>01 / INPUT</Badge>
                      </div>
                      <div className="panel-body">
                        <fieldset disabled={!!busy} className="request-fields">
                          <div className="field-row three">
                            <label>
                              Task type
                              <select
                                value={input.task}
                                onChange={(e) =>
                                  edit({
                                    task: e.target
                                      .value as RequestInput["task"],
                                  })
                                }
                              >
                                <option value="coding">Coding</option>
                                <option value="analysis">Analysis</option>
                                <option value="writing">Writing</option>
                                <option value="qa">Question answering</option>
                              </select>
                            </label>
                            <label>
                              Importance
                              <select
                                aria-label="Importance"
                                aria-describedby="importance-help"
                                value={input.importance}
                                onChange={(e) =>
                                  edit({
                                    importance: e.target
                                      .value as RequestInput["importance"],
                                  })
                                }
                              >
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                              </select>
                            </label>
                            <label>
                              Requested by
                              <select
                                value={input.userId}
                                onChange={(e) =>
                                  edit({ userId: e.target.value })
                                }
                              >
                                {workspace.settings.users.map((user) => (
                                  <option value={user.id} key={user.id}>
                                    {user.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                          <p id="importance-help" className="importance-help">
                            {importanceMultiplier(
                              input.importance,
                              resolveCompanyPolicy(effectiveSettings!),
                            )}
                            × allowance and quality preference. Low: routine
                            ideas; Medium: regular updates; High: urgent
                            customer issues. Quality floor stays fixed.
                          </p>
                          <label className="prompt-label">
                            Your prompt <span>Be as specific as you like</span>
                            <textarea
                              className="prompt-input"
                              value={input.prompt}
                              onChange={(e) => edit({ prompt: e.target.value })}
                              rows={7}
                              placeholder="What would you like the model to do?"
                            />
                          </label>
                          <div className="prompt-meta">
                            <span>
                              {input.prompt.length.toLocaleString()} characters
                            </span>
                            <span>
                              <ShieldCheck size={12} />
                              {input.mode === "simulation"
                                ? "Simulated · no model API call"
                                : "Sent to your local model"}
                            </span>
                          </div>
                          <div className="example-row">
                            <span>Try an example</span>
                            <button
                              type="button"
                              onClick={() => {
                                edit({ task: suggestTask(input.prompt) });
                                setNotice(
                                  "Task suggested from keywords. You can change it using the Task type control.",
                                );
                              }}
                            >
                              Suggest task
                              <Sparkles size={11} />
                            </button>
                            {examples.map((example) => (
                              <button
                                type="button"
                                key={example.label}
                                onClick={() =>
                                  edit({
                                    prompt: example.text,
                                    task: example.task,
                                  })
                                }
                              >
                                {example.label}
                                <ArrowUpRight size={11} />
                              </button>
                            ))}
                          </div>
                          <div className="form-divider" />
                          <div className="constraints-title">
                            <h3>Request guardrails</h3>
                            <span>Give the router your boundaries</span>
                          </div>
                          <div className="field-row">
                            <label>
                              Minimum quality{" "}
                              <span className="field-value">
                                {Math.round(input.qualityFloor * 100)}/100
                              </span>
                              <input
                                type="range"
                                min="0"
                                max="100"
                                value={input.qualityFloor * 100}
                                onChange={(e) =>
                                  edit({
                                    qualityFloor: Number(e.target.value) / 100,
                                  })
                                }
                              />
                              <span className="range-labels">
                                <span>Flexible</span>
                                <span>Exacting</span>
                              </span>
                            </label>
                            <label>
                              Latency target{" "}
                              <span className="field-value">
                                {input.latencyTarget}s
                              </span>
                              <input
                                type="range"
                                min="1"
                                max="60"
                                value={input.latencyTarget}
                                onChange={(e) =>
                                  edit({
                                    latencyTarget: Number(e.target.value),
                                  })
                                }
                              />
                              <span className="range-labels">
                                <span>Fastest</span>
                                <span>More time</span>
                              </span>
                            </label>
                          </div>
                          <div className="field-row">
                            <label>
                              Expected output
                              <select
                                value={input.outputTokens}
                                onChange={(e) =>
                                  edit({ outputTokens: Number(e.target.value) })
                                }
                              >
                                {[128, 256, 512, 1000, 1024, 2048, 4096].map(
                                  (n) => (
                                    <option key={n} value={n}>
                                      {n.toLocaleString()} tokens
                                      {n === 512
                                        ? " · concise"
                                        : n === 1000 || n === 1024
                                          ? " · standard"
                                          : n === 2048
                                            ? " · detailed"
                                            : ""}
                                    </option>
                                  ),
                                )}
                              </select>
                            </label>
                            <label>
                              Execution mode
                              <select
                                value={input.mode}
                                onChange={(e) =>
                                  edit({
                                    mode: e.target
                                      .value as RequestInput["mode"],
                                    localOnly: e.target.value === "local",
                                  })
                                }
                              >
                                <option value="simulation">
                                  Simulation · $0 actual charges
                                </option>
                                <option
                                  value="local"
                                  disabled={!workspace.localAvailable}
                                >
                                  Local model
                                  {!workspace.localAvailable
                                    ? " · unavailable"
                                    : ` · ${workspace.localModel}`}
                                </option>
                              </select>
                            </label>
                          </div>
                          {input.mode === "local" &&
                            !workspace.localQualityReady && (
                              <div className="inline-warning">
                                Some local tasks still need calibration. Open
                                Evaluation → Calibration split, load a prompt,
                                set minimum quality to 0, and turn off strict
                                latency. Run locally, then rate the response in
                                Run history.
                              </div>
                            )}
                          <button
                            type="button"
                            className="advanced-toggle"
                            aria-expanded={advanced}
                            onClick={() => setAdvanced(!advanced)}
                          >
                            <SlidersHorizontal size={14} />
                            Advanced preferences
                            <ChevronDown
                              size={14}
                              className={advanced ? "rotate" : ""}
                            />
                          </button>
                          {advanced && (
                            <div className="advanced-content">
                              <div className="field-row">
                                <label>
                                  Maximum request cost ($)
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.001"
                                    placeholder="Use policy allowance"
                                    value={input.maxRequestCost ?? ""}
                                    onChange={(e) =>
                                      edit({
                                        maxRequestCost:
                                          e.target.value === ""
                                            ? null
                                            : Number(e.target.value),
                                      })
                                    }
                                  />
                                </label>
                                <div className="checkbox-stack">
                                  <label className="checkbox-label">
                                    <input
                                      type="checkbox"
                                      checked={input.strictLatency}
                                      onChange={(e) =>
                                        edit({
                                          strictLatency: e.target.checked,
                                        })
                                      }
                                    />
                                    Enforce latency as a hard limit
                                  </label>
                                  <label className="checkbox-label">
                                    <input
                                      type="checkbox"
                                      checked={input.localOnly}
                                      onChange={(e) =>
                                        edit({ localOnly: e.target.checked })
                                      }
                                    />
                                    Privacy: local models only
                                  </label>
                                </div>
                              </div>
                              <h4>Preference weights</h4>
                              <p className="helper">
                                Relative weights are normalized by the policy
                                agent. Budget pressure can increase the cost
                                preference.
                              </p>
                              <div className="field-row three">
                                {(["quality", "cost", "latency"] as const).map(
                                  (key) => (
                                    <label key={key} className="capitalize">
                                      {key}
                                      <input
                                        type="number"
                                        min="0"
                                        max="1"
                                        step="0.05"
                                        value={input.weights[key]}
                                        onChange={(e) =>
                                          edit({
                                            weights: {
                                              ...input.weights,
                                              [key]: Number(e.target.value),
                                            },
                                          })
                                        }
                                      />
                                    </label>
                                  ),
                                )}
                              </div>
                              <div className="field-row">
                                <div>
                                  <h4>Preferred models</h4>
                                  <p className="helper">
                                    A preference never overrides a guardrail.
                                  </p>
                                  {workspace.models.map((model) => (
                                    <label
                                      className="checkbox-label"
                                      key={model.id}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={input.preferredModels.includes(
                                          model.id,
                                        )}
                                        onChange={() =>
                                          toggleModel(
                                            "preferredModels",
                                            model.id,
                                          )
                                        }
                                      />
                                      {model.name}
                                    </label>
                                  ))}
                                </div>
                                <div>
                                  <h4>Blocked for this request</h4>
                                  <p className="helper">
                                    Excluded before scoring.
                                  </p>
                                  {workspace.models.map((model) => (
                                    <label
                                      className="checkbox-label"
                                      key={model.id}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={input.blockedModels.includes(
                                          model.id,
                                        )}
                                        onChange={() =>
                                          toggleModel("blockedModels", model.id)
                                        }
                                      />
                                      {model.name}
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </fieldset>
                        <div className="composer-actions">
                          <button
                            className="button secondary"
                            disabled={
                              !!busy ||
                              !!budgetDraftError ||
                              !!policyDraftError ||
                              !input.prompt.trim()
                            }
                            onClick={() =>
                              operate("preview", async () => {
                                setResult(null);
                                setPreview(
                                  await api<Preview>("/api/preview", {
                                    input,
                                    ...(previewSettings
                                      ? { settings: previewSettings }
                                      : {}),
                                  }),
                                );
                              })
                            }
                          >
                            {busy === "preview" ? (
                              <Loading>Previewing</Loading>
                            ) : (
                              <>
                                <Sparkles size={15} />
                                Preview routing
                              </>
                            )}
                          </button>
                          <button
                            className="button primary"
                            disabled={
                              !!busy ||
                              !!budgetDraftError ||
                              policyDirty ||
                              !input.prompt.trim()
                            }
                            onClick={() =>
                              operate("run", async () => {
                                await persistBudgetDraft();
                                const run = await api<RunRecord>("/api/run", {
                                  input,
                                  idempotencyKey: crypto.randomUUID(),
                                });
                                setResult(run);
                                setPreview(run.preview);
                                const data =
                                  await api<Workspace>("/api/workspace");
                                setWorkspace(data);
                              })
                            }
                          >
                            {busy === "run" ? (
                              <Loading>Running request</Loading>
                            ) : (
                              <>
                                <Play size={14} fill="currentColor" />
                                {input.mode === "local"
                                  ? "Run locally"
                                  : "Run simulation"}
                                <ArrowRight size={15} />
                              </>
                            )}
                          </button>
                        </div>
                        <p className="action-note">
                          {calculating
                            ? "Updating policy automatically…"
                            : policyDirty
                              ? (policyDraftError ??
                                "Save company policy before running this request. Previews use your draft rules.")
                              : calculationError
                                ? calculationError
                                : "Policy updates as you type. Running saves your budget and records a response."}
                        </p>
                      </div>
                    </section>
                    <PolicyInspector
                      preview={preview}
                      loading={
                        busy === "init" || busy === "preview" || calculating
                      }
                    />
                  </div>
                  <CandidatePanel preview={preview} />
                  {result && <ResponsePanel run={result} />}
                  <div className="bottom-note">
                    <ShieldCheck size={14} />
                    <span>
                      Transparent by design. Catalog scores and simulated
                      timings are illustrative, not provider benchmarks.
                    </span>
                    <span className="version">ORCHESTRA / PROTOTYPE</span>
                  </div>
                </>
              )}

              {view === "history" && (
                <div className="history-layout">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <History size={18} />
                        <h2>Recent runs</h2>
                      </div>
                      <Badge>{workspace.history.length} requests</Badge>
                    </div>
                    {!workspace.history.length ? (
                      <EmptyState
                        icon={<History size={30} />}
                        title="Your decisions start here"
                        text="Run a request in the lab to capture its policy, selected model, response, and cost."
                        action={
                          <button
                            className="button primary"
                            onClick={() => setView("lab")}
                          >
                            Open request lab
                            <ArrowRight size={15} />
                          </button>
                        }
                      />
                    ) : (
                      <div className="history-list">
                        {workspace.history.map((run) => (
                          <button
                            key={run.id}
                            className={`history-item ${selectedHistory?.id === run.id ? "selected" : ""}`}
                            onClick={() => {
                              setSelectedHistory(run);
                              setRatings(
                                run.rating
                                  ? {
                                      correctness: run.rating.correctness,
                                      completeness: run.rating.completeness,
                                      instructionFollowing:
                                        run.rating.instructionFollowing,
                                    }
                                  : {
                                      correctness: 4,
                                      completeness: 4,
                                      instructionFollowing: 4,
                                    },
                              );
                            }}
                          >
                            <span className="history-icon">
                              <Code2 size={17} />
                            </span>
                            <div>
                              <strong>
                                {run.input.prompt.slice(0, 74)}
                                {run.input.prompt.length > 74 ? "…" : ""}
                              </strong>
                              <span>
                                {run.preview.selected?.model.name ||
                                  "No eligible model"}{" "}
                                · {new Date(run.createdAt).toLocaleString()}
                              </span>
                            </div>
                            <div className="history-cost">
                              <Badge
                                tone={
                                  run.status === "completed" ? "sage" : "amber"
                                }
                              >
                                {run.status}
                              </Badge>
                              <small>
                                {run.input.mode === "simulation"
                                  ? "Simulated"
                                  : "Local"}{" "}
                                ·{" "}
                                {money(run.simulatedCost || run.actualCost, 5)}
                              </small>
                            </div>
                            <ChevronRight size={16} />
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                  {selectedHistory && (
                    <>
                      <ResponsePanel run={selectedHistory} />
                      <PolicyInspector
                        preview={selectedHistory.preview}
                        loading={false}
                      />
                      <CandidatePanel preview={selectedHistory.preview} />
                      {selectedHistory.input.mode === "local" &&
                        selectedHistory.status === "completed" && (
                          <section className="panel">
                            <div className="panel-heading">
                              <div>
                                <CheckCircle2 size={18} />
                                <h2>Human quality rating</h2>
                              </div>
                              <Badge>LOCAL MEASUREMENT</Badge>
                            </div>
                            <div className="panel-body">
                              <p className="helper">
                                Rate this actual local response from 1 (poor) to
                                5 (excellent). Ratings on benchmark calibration
                                prompts update routing estimates. Ratings on
                                other prompts are saved for evaluation only.
                              </p>
                              <div className="field-row three">
                                {(
                                  [
                                    "correctness",
                                    "completeness",
                                    "instructionFollowing",
                                  ] as const
                                ).map((key) => (
                                  <label key={key}>
                                    {key === "instructionFollowing"
                                      ? "Instruction following"
                                      : key[0].toUpperCase() + key.slice(1)}
                                    <select
                                      value={ratings[key]}
                                      onChange={(e) =>
                                        setRatings({
                                          ...ratings,
                                          [key]: Number(e.target.value),
                                        })
                                      }
                                    >
                                      {[1, 2, 3, 4, 5].map((value) => (
                                        <option key={value} value={value}>
                                          {value} / 5
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                ))}
                              </div>
                              <button
                                className="button primary"
                                disabled={!!busy}
                                onClick={() =>
                                  operate("rating", async () => {
                                    const run = await api<RunRecord>(
                                      "/api/ratings",
                                      { id: selectedHistory.id, ...ratings },
                                    );
                                    setSelectedHistory(run);
                                    setWorkspace(
                                      await api<Workspace>("/api/workspace"),
                                    );
                                    setNotice(
                                      "Rating saved. Only benchmark calibration prompts update routing estimates; other ratings are retained for evaluation.",
                                    );
                                  })
                                }
                              >
                                {busy === "rating" ? (
                                  <Loading>Saving</Loading>
                                ) : (
                                  "Save rating"
                                )}
                              </button>
                            </div>
                          </section>
                        )}
                    </>
                  )}
                </div>
              )}

              {view === "evaluation" && (
                <>
                  <section className="panel evaluation-intro">
                    <div>
                      <span className="eyebrow">A CONTROLLED COMPARISON</span>
                      <h2>One workload. Four ways to route.</h2>
                      <p>
                        Compare strongest, cheapest, fixed, and adaptive routing
                        using the current request constraints and workspace
                        budget. Every strategy receives the same illustrative
                        workload.
                      </p>
                      {input.mode === "local" && (
                        <p className="inline-warning">
                          This comparison uses simulated model profiles. Switch
                          execution mode to Simulation in Request lab to run it.
                          Real local responses remain available in Run history.
                        </p>
                      )}
                      <div className="inline-tags">
                        <Badge>Same constraints</Badge>
                        <Badge>Same budget</Badge>
                        <Badge>Illustrative quality & latency</Badge>
                      </div>
                    </div>
                    <button
                      className="button primary"
                      disabled={
                        !!busy ||
                        !!budgetDraftError ||
                        !!policyDraftError ||
                        input.mode === "local"
                      }
                      onClick={() =>
                        operate("evaluate", async () =>
                          setEvaluation(
                            await api<EvaluationResult>("/api/evaluate", {
                              input,
                              ...(previewSettings
                                ? { settings: previewSettings }
                                : {}),
                            }),
                          ),
                        )
                      }
                    >
                      {busy === "evaluate" ? (
                        <Loading>Evaluating</Loading>
                      ) : (
                        <>
                          <Play size={15} />
                          Run comparison
                        </>
                      )}
                    </button>
                  </section>
                  {evaluation ? (
                    <EvaluationPanel evaluation={evaluation} />
                  ) : (
                    <section className="panel">
                      <EmptyState
                        icon={<BarChart3 size={32} />}
                        title="Make the tradeoffs visible"
                        text="Run a comparison to explore estimated cost, completion rate, quality, latency, and constraint satisfaction across four strategies."
                      />
                    </section>
                  )}
                  <section className="panel benchmark-panel">
                    <div className="panel-heading">
                      <div>
                        <FlaskConical size={18} />
                        <h2>Benchmark prompt library</h2>
                      </div>
                      <Badge>{benchmarkPrompts.length} PROMPTS</Badge>
                    </div>
                    <div className="panel-body">
                      <p className="helper">
                        Use the calibration split to collect human ratings on
                        real local responses. Held-out evaluation prompts never
                        train the local quality profile. Simulation responses
                        are never treated as measured quality.
                      </p>
                      <div
                        className="benchmark-tabs"
                        role="group"
                        aria-label="Benchmark split"
                      >
                        {(["all", "calibration", "evaluation"] as const).map(
                          (split) => (
                            <button
                              type="button"
                              key={split}
                              aria-pressed={benchmarkFilter === split}
                              className={
                                benchmarkFilter === split ? "selected" : ""
                              }
                              onClick={() => setBenchmarkFilter(split)}
                            >
                              {split === "all"
                                ? "All prompts"
                                : split === "calibration"
                                  ? "Calibration split"
                                  : "Held-out evaluation"}
                            </button>
                          ),
                        )}
                      </div>
                      <div className="benchmark-list">
                        {benchmarkPrompts
                          .filter(
                            (prompt) =>
                              benchmarkFilter === "all" ||
                              prompt.split === benchmarkFilter,
                          )
                          .map((prompt) => (
                            <details
                              key={prompt.id}
                              className="benchmark-prompt"
                            >
                              <summary>
                                <span className="benchmark-id">
                                  {prompt.id}
                                </span>
                                <span className="benchmark-snippet">
                                  {prompt.prompt}
                                </span>
                                <Badge
                                  tone={
                                    prompt.split === "calibration"
                                      ? "sage"
                                      : "muted"
                                  }
                                >
                                  {prompt.task} · {prompt.split}
                                </Badge>
                                <ChevronDown size={14} />
                              </summary>
                              <div>
                                <p>{prompt.prompt}</p>
                                <p className="helper">
                                  <strong>Rubric:</strong> {prompt.rubric}
                                </p>
                                <button
                                  className="button secondary"
                                  type="button"
                                  disabled={!!busy}
                                  onClick={() => {
                                    edit({
                                      prompt: prompt.prompt,
                                      task: prompt.task,
                                      ...(input.mode === "local" &&
                                      prompt.split === "calibration"
                                        ? {
                                            qualityFloor: 0,
                                            strictLatency: false,
                                          }
                                        : {}),
                                    });
                                    setView("lab");
                                    setNotice(
                                      `${prompt.split === "calibration" ? "Calibration" : "Held-out evaluation"} prompt loaded. ${input.mode === "local" ? "Run locally and rate the response in history." : "Switch to a configured local model to collect real measurements."}`,
                                    );
                                  }}
                                >
                                  Load in request lab
                                  <ArrowRight size={14} />
                                </button>
                              </div>
                            </details>
                          ))}
                      </div>
                    </div>
                  </section>
                </>
              )}

              {view === "workspace" && (
                <section className="panel settings-panel">
                  <div className="panel-heading">
                    <div>
                      <Settings2 size={18} />
                      <h2>Budget & workspace</h2>
                    </div>
                    <Badge>LOCAL PERSISTENCE</Badge>
                  </div>
                  <form
                    className="panel-body"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveSettings(draftSettings);
                    }}
                  >
                    <fieldset disabled={!!busy}>
                      <div className="field-row">
                        <label>
                          Workspace name
                          <input
                            required
                            value={draftSettings.teamName}
                            onChange={(e) =>
                              setDraftSettings({
                                ...draftSettings,
                                teamName: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Simulated date
                          <input
                            required
                            type="date"
                            value={draftSettings.simulatedDate}
                            onChange={(e) =>
                              setDraftSettings({
                                ...draftSettings,
                                simulatedDate: e.target.value,
                                scenario: "custom",
                              })
                            }
                          />
                        </label>
                      </div>
                      <div className="field-row three">
                        <label>
                          Monthly budget ($)
                          <input
                            required
                            type="number"
                            min="0"
                            step="0.01"
                            value={draftSettings.monthlyBudget}
                            onChange={(e) =>
                              setDraftSettings({
                                ...draftSettings,
                                monthlyBudget: Number(e.target.value),
                                scenario: "custom",
                              })
                            }
                          />
                        </label>
                        <label>
                          Expected monthly requests
                          <input
                            required
                            type="number"
                            min="1"
                            step="1"
                            value={draftSettings.monthlyRequests}
                            onChange={(e) =>
                              setDraftSettings({
                                ...draftSettings,
                                monthlyRequests: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label>
                          Opening simulated spend ($)
                          <input
                            required
                            type="number"
                            min="0"
                            step="0.01"
                            value={draftSettings.openingSpend}
                            onChange={(e) =>
                              setDraftSettings({
                                ...draftSettings,
                                openingSpend: Number(e.target.value),
                                scenario: "custom",
                              })
                            }
                          />
                        </label>
                      </div>
                      <div className="formula-note">
                        <CircleHelp size={17} />
                        <p>
                          Remaining budget subtracts opening spend, recorded
                          spend, and reservations. The policy allocates
                          remaining funds across forecast requests, adjusts for
                          importance and budget pressure, then enforces request
                          and user limits.
                        </p>
                      </div>
                      <div className="form-divider" />
                      <h3>Team members</h3>
                      <p className="helper">
                        Optional monthly user caps constrain individual requests
                        alongside the shared team budget. Leave a cap empty to
                        use the team budget.
                      </p>
                      {draftSettings.users.map((user, index) => (
                        <div className="member-row" key={user.id}>
                          <span className="member-avatar">
                            {user.name
                              .split(" ")
                              .map((part) => part[0])
                              .join("")
                              .slice(0, 2)}
                          </span>
                          <div>
                            <strong>{user.name}</strong>
                            <small>{user.role}</small>
                          </div>
                          <label>
                            Monthly cap ($)
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="No individual cap"
                              value={user.budget ?? ""}
                              onChange={(e) =>
                                setDraftSettings({
                                  ...draftSettings,
                                  users: draftSettings.users.map((member, i) =>
                                    i === index
                                      ? {
                                          ...member,
                                          budget:
                                            e.target.value === ""
                                              ? null
                                              : Number(e.target.value),
                                        }
                                      : member,
                                  ),
                                })
                              }
                            />
                          </label>
                        </div>
                      ))}
                      <div className="form-divider" />
                      <h3>Workspace model blocks</h3>
                      <p className="helper">
                        Blocked models are excluded from every routing decision
                        in this workspace.
                      </p>
                      <div className="model-block-grid">
                        {workspace.models.map((model) => (
                          <label className="model-block" key={model.id}>
                            <input
                              type="checkbox"
                              checked={draftSettings.blockedModels.includes(
                                model.id,
                              )}
                              onChange={(e) =>
                                setDraftSettings({
                                  ...draftSettings,
                                  blockedModels: e.target.checked
                                    ? [...draftSettings.blockedModels, model.id]
                                    : draftSettings.blockedModels.filter(
                                        (id) => id !== model.id,
                                      ),
                                })
                              }
                            />
                            <div>
                              <strong>{model.name}</strong>
                              <span>
                                {model.provider} ·{" "}
                                {model.source === "measured"
                                  ? "Measured local profile"
                                  : "Illustrative profile"}
                              </span>
                            </div>
                          </label>
                        ))}
                      </div>
                      <div className="form-divider" />
                      <div className="local-status">
                        <div>
                          <h3>Local model connection</h3>
                          <p>
                            {workspace.localAvailable
                              ? `Configured for ${workspace.localModel}; availability is checked when a request runs. ${workspace.localQualityReady ? "Measured quality is available." : "Quality calibration is still needed."}`
                              : "No local runtime configured. Simulation is ready to use."}
                          </p>
                        </div>
                        <Badge
                          tone={workspace.localAvailable ? "sage" : "muted"}
                        >
                          {workspace.localAvailable
                            ? "Configured"
                            : "Not configured"}
                        </Badge>
                      </div>
                      <div className="settings-actions">
                        <a
                          className="button secondary"
                          href="/api/export?format=csv"
                          download
                        >
                          <ArrowDownToLine size={15} />
                          Export run CSV
                        </a>
                        <button className="button primary" type="submit">
                          {busy === "settings" ? (
                            <Loading>Saving</Loading>
                          ) : (
                            <>
                              <Check size={15} />
                              Save settings
                            </>
                          )}
                        </button>
                      </div>
                    </fieldset>
                  </form>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function PolicyInspector({
  preview,
  loading,
}: {
  preview: Preview | null;
  loading: boolean;
}) {
  const policy = preview?.policy;
  return (
    <section className="panel policy-panel">
      <div className="panel-heading">
        <div>
          <span className="section-icon sage-icon">
            <Layers3 size={18} />
          </span>
          <h2>Policy inspector</h2>
        </div>
        <Badge tone="sage">AGENT 01</Badge>
      </div>
      <div className="panel-body">
        {!policy ? (
          <EmptyState
            icon={
              loading ? (
                <LoaderCircle size={28} className="spin" />
              ) : (
                <SlidersHorizontal size={28} />
              )
            }
            title={
              loading ? "Building your policy" : "Ready for a fresh perspective"
            }
            text={
              loading
                ? "Reading the budget and request constraints…"
                : "Preview routing to translate your request and budget into an inspectable policy."
            }
          />
        ) : (
          <>
            <div className="policy-status">
              <span className="status-dot" />
              <strong>Budget-aware policy</strong>
              <span>v{policy.version}</span>
            </div>
            <p className="policy-description">
              Your request, translated into a clear set of priorities and
              constraints.
            </p>
            <div className="weights-heading">
              <h3>Routing priorities</h3>
              <span>Adjusted by policy</span>
            </div>
            <div className="weight-bar">
              {(["quality", "cost", "latency"] as const).map((key) => (
                <span
                  key={key}
                  className={`weight-${key}`}
                  style={{ flex: policy.weights[key] || 0.001 }}
                  title={`${key}: ${pct(policy.weights[key])}`}
                />
              ))}
            </div>
            <div className="weight-legend">
              {(["quality", "cost", "latency"] as const).map((key) => (
                <div key={key}>
                  <span className={`legend-dot weight-${key}`} />
                  <span className="capitalize">{key}</span>
                  <strong>{(policy.weights[key] * 100).toFixed(1)}%</strong>
                </div>
              ))}
            </div>
            <div className="policy-metrics">
              <div>
                <span>Request allowance</span>
                <strong>{money(policy.maxCostPerRequest, 5)}</strong>
              </div>
              <div>
                <span>Quality floor</span>
                <strong>
                  {Math.round(policy.qualityFloor * 100)}
                  <small> / 100</small>
                </strong>
              </div>
              <div>
                <span>Latency target</span>
                <strong>
                  {policy.latencyTarget}s
                  <small>
                    {" "}
                    · {policy.strictLatency ? "hard limit" : "soft target"}
                  </small>
                </strong>
              </div>
              <div>
                <span>Forecast requests left</span>
                <strong>
                  {Math.round(
                    policy.budget.expectedRemainingRequests,
                  ).toLocaleString()}
                </strong>
              </div>
              <div>
                <span>Projected monthly spend</span>
                <strong>{money(policy.budget.projectedSpend)}</strong>
              </div>
              <div>
                <span>Budget pressure</span>
                <strong>{pct(policy.budget.pressure)}</strong>
              </div>
              {policy.budget.userRemaining !== null && (
                <div>
                  <span>User budget remaining</span>
                  <strong>{money(policy.budget.userRemaining)}</strong>
                </div>
              )}
            </div>
            <PolicyCalculationDetails policy={policy} />
            <div className="reasoning">
              <h3>
                <Sparkles size={14} />
                Why this policy?
              </h3>
              {policy.reasons.map((reason, index) => (
                <p key={index}>
                  <Check size={13} />
                  <span>{reason}</span>
                </p>
              ))}
            </div>
            <details className="policy-details">
              <summary>
                Assumptions & calculation notes
                <ChevronDown size={14} />
              </summary>
              <ul>
                {policy.assumptions.map((assumption, index) => (
                  <li key={index}>{assumption}</li>
                ))}
              </ul>
              <p>
                Candidate scores combine normalized quality, cost efficiency,
                and speed. Ineligible models cannot win, regardless of score.
              </p>
            </details>
            <details className="policy-details">
              <summary>
                <span>
                  <Code2 size={14} />
                  View policy contract
                </span>
                <ChevronDown size={14} />
              </summary>
              <pre>{JSON.stringify(policy, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
    </section>
  );
}

function CandidatePanel({ preview }: { preview: Preview | null }) {
  return (
    <section className="panel candidate-panel">
      <div className="panel-heading">
        <div>
          <span className="section-icon">
            <Zap size={18} />
          </span>
          <h2>Model selection</h2>
          <span className="muted heading-description">
            The best fit, within your guardrails.
          </span>
        </div>
        <Badge>AGENT 02</Badge>
      </div>
      {!preview ? (
        <div className="candidate-empty">
          <Layers3 size={19} />
          <span>
            Preview a request to compare eligible models and see the selected
            route.
          </span>
        </div>
      ) : (
        <>
          <div className="selection-banner">
            <span className="selection-icon">
              {preview.selected ? (
                <CheckCircle2 size={22} />
              ) : (
                <ShieldCheck size={22} />
              )}
            </span>
            <div>
              <span className="eyebrow">
                {preview.selected ? "RECOMMENDED ROUTE" : "NO ELIGIBLE ROUTE"}
              </span>
              <strong>
                {preview.selected?.model.name ||
                  "Your guardrails cannot currently be met"}
              </strong>
              <p>
                {preview.selected
                  ? `${preview.selected.model.provider} · ${preview.selected.model.local ? "Local model" : "Simulated execution"} · Highest eligible weighted score`
                  : "Review the candidate reasons below, then adjust the constraints or budget."}
              </p>
            </div>
            {preview.selected && (
              <div className="selection-numbers">
                <div>
                  <strong>
                    {Math.round(preview.selected.estimatedQuality * 100)}
                    <small>/100</small>
                  </strong>
                  <span>Est. quality</span>
                </div>
                <div>
                  <strong>{money(preview.selected.estimatedCost, 5)}</strong>
                  <span>Est. request cost</span>
                </div>
                <div>
                  <strong>
                    {preview.selected.estimatedLatency.toFixed(1)}
                    <small>s</small>
                  </strong>
                  <span>Est. latency</span>
                </div>
              </div>
            )}
          </div>
          <div className="table-scroll">
            <table className="candidate-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Quality</th>
                  <th>Est. cost</th>
                  <th>Latency</th>
                  <th>Score</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {[...preview.candidates]
                  .sort(
                    (a, b) =>
                      Number(b.eligible) - Number(a.eligible) ||
                      (b.score ?? -1) - (a.score ?? -1),
                  )
                  .map((candidate) => {
                    const selected =
                      candidate.model.id === preview.selected?.model.id;
                    return (
                      <tr
                        key={candidate.model.id}
                        className={
                          selected
                            ? "selected-row"
                            : !candidate.eligible
                              ? "excluded-row"
                              : ""
                        }
                      >
                        <td>
                          <div className="model-cell">
                            <span
                              className={`model-glyph ${candidate.model.tier}`}
                            >
                              <Layers3 size={15} />
                            </span>
                            <div>
                              <strong>
                                {candidate.model.name}
                                {candidate.preferred && (
                                  <span className="preferred-star">★</span>
                                )}
                              </strong>
                              <small>
                                {candidate.model.provider} ·{" "}
                                {candidate.model.source}
                              </small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="quality-cell">
                            {Math.round(candidate.estimatedQuality * 100)}
                            <span className="mini-track">
                              <i
                                style={{
                                  width: `${candidate.estimatedQuality * 100}%`,
                                }}
                              />
                            </span>
                          </span>
                        </td>
                        <td>{money(candidate.estimatedCost, 5)}</td>
                        <td>{candidate.estimatedLatency.toFixed(1)}s</td>
                        <td className="score-cell">
                          {candidate.score === null
                            ? "—"
                            : candidate.score.toFixed(3)}
                        </td>
                        <td>
                          <Badge
                            tone={
                              selected
                                ? "sage"
                                : candidate.eligible
                                  ? "muted"
                                  : "amber"
                            }
                          >
                            {selected ? (
                              <>
                                <Check size={11} />
                                Selected
                              </>
                            ) : candidate.eligible ? (
                              "Eligible"
                            ) : (
                              "Excluded"
                            )}
                          </Badge>
                          {candidate.reasons.length > 0 && (
                            <div className="candidate-reasons">
                              {candidate.reasons.join(" · ")}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <div className="table-footer">
            <span>
              <CircleHelp size={13} />
              Estimates use task-specific catalog profiles. Simulated costs are
              not actual charges.
            </span>
            <span>Router overhead: {preview.routingMs.toFixed(2)} ms</span>
          </div>
        </>
      )}
    </section>
  );
}

function ResponsePanel({ run }: { run: RunRecord }) {
  return (
    <section className="panel response-panel">
      <div className="panel-heading">
        <div>
          <span className="section-icon sage-icon">
            <Sparkles size={18} />
          </span>
          <h2>
            {run.input.mode === "simulation"
              ? "Simulated response"
              : "Local model response"}
          </h2>
        </div>
        <Badge tone={run.status === "completed" ? "sage" : "amber"}>
          {run.status}
        </Badge>
      </div>
      <div className="panel-body">
        <div className="response-meta">
          <span>{run.preview.selected?.model.name || "No model selected"}</span>
          <span>
            Actual charges{" "}
            <strong>{money(run.actualCost, run.actualCost ? 5 : 2)}</strong>
          </span>
          <span>
            Simulated cost <strong>{money(run.simulatedCost, 5)}</strong>
          </span>
          <span>
            {run.measuredLatencyMs !== null
              ? `${(run.measuredLatencyMs / 1000).toFixed(2)}s measured`
              : `${run.simulatedLatency?.toFixed(1) ?? "—"}s illustrative`}
          </span>
        </div>
        {run.input.mode === "simulation" && (
          <div className="simulation-label">
            <FlaskConical size={14} />
            Illustrative response template · no model inference was performed
          </div>
        )}
        {run.error && <div className="inline-warning">{run.error}</div>}
        <pre className="response-text">
          {run.response || "No response was produced for this request."}
        </pre>
        <div className="response-footer">
          <span>
            {run.inputTokens.toLocaleString()} input /{" "}
            {run.outputTokens.toLocaleString()} output tokens
            {run.input.mode === "simulation" ? " (estimated)" : ""}
          </span>
          <span>
            {run.rating
              ? `Human quality: ${Math.round(run.rating.score * 100)}/100`
              : run.input.mode === "local"
                ? "Quality: awaiting human rating"
                : "Quality: illustrative catalog estimate"}
          </span>
        </div>
      </div>
    </section>
  );
}

function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

function QualitySeries({
  values,
  color,
  emphasis,
}: {
  values: (number | null)[];
  color: string;
  emphasis: boolean;
}) {
  const x = (index: number) =>
    34 + (index / Math.max(1, values.length - 1)) * 430;
  return (
    <g>
      {values.map((value, index) => {
        if (value === null) return null;
        const previous = index > 0 ? values[index - 1] : null;
        return (
          <g key={index}>
            {previous !== null && (
              <line
                x1={x(index - 1)}
                y1={160 - previous * 140}
                x2={x(index)}
                y2={160 - value * 140}
                stroke={color}
                strokeWidth={emphasis ? 3 : 2}
              />
            )}
            <circle
              cx={x(index)}
              cy={160 - value * 140}
              r={emphasis ? 2.3 : 1.6}
              fill={color}
            >
              <title>
                Request {index + 1}: {Math.round(value * 100)}/100 illustrative
                quality
              </title>
            </circle>
          </g>
        );
      })}
    </g>
  );
}

function EvaluationPanel({ evaluation }: { evaluation: EvaluationResult }) {
  const maxCost = Math.max(
    0.0001,
    ...evaluation.rows.map((row) => row.totalCost),
  );
  const strategyLabel = (value: string) =>
    value === "fixed"
      ? "Fixed policy"
      : value === "adaptive"
        ? "Orchestra adaptive"
        : `${value[0].toUpperCase() + value.slice(1)} model`;
  return (
    <>
      <div className="evaluation-caveat">
        <FlaskConical size={17} />
        <p>
          {evaluation.caveat} All plotted quality and completion latencies below
          are illustrative. Gaps mark rejected requests.
        </p>
        <Badge>{evaluation.sampleCount} prompts</Badge>
      </div>
      <div className="chart-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <Coins size={18} />
              <h2>Cost by strategy</h2>
            </div>
            <Badge>SIMULATED</Badge>
          </div>
          <div className="cost-chart">
            {evaluation.rows.map((row) => (
              <div
                key={row.strategy}
                className={`chart-row ${row.strategy === "adaptive" ? "adaptive" : ""}`}
              >
                <div>
                  <span>{strategyLabel(row.strategy)}</span>
                  <strong>{money(row.totalCost, 4)}</strong>
                </div>
                <div className="chart-track">
                  <span
                    style={{ width: `${(row.totalCost / maxCost) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <Activity size={18} />
              <h2>Quality over the workload</h2>
            </div>
            <Badge>ILLUSTRATIVE</Badge>
          </div>
          <div className="line-chart">
            <svg
              viewBox="0 0 480 190"
              role="img"
              aria-label="Illustrative quality scores by request and routing strategy"
            >
              {[0, 25, 50, 75, 100].map((value) => (
                <g key={value}>
                  <line
                    x1="34"
                    x2="468"
                    y1={160 - value * 1.4}
                    y2={160 - value * 1.4}
                    stroke="#e8ece8"
                  />
                  <text
                    x="3"
                    y={164 - value * 1.4}
                    fontSize="10"
                    fill="#84908d"
                  >
                    {value}
                  </text>
                </g>
              ))}
              {evaluation.rows.map((row, index) => (
                <QualitySeries
                  key={row.strategy}
                  values={row.qualityOverTime}
                  color={["#a0a1c5", "#c5a06a", "#7b9eb5", "#39806b"][index]}
                  emphasis={row.strategy === "adaptive"}
                />
              ))}
              <text x="34" y="183" fill="#84908d" fontSize="10">
                First request
              </text>
              <text x="414" y="183" fill="#84908d" fontSize="10">
                Last request
              </text>
            </svg>
            <div className="chart-legend">
              {evaluation.rows.map((row, index) => (
                <span key={row.strategy}>
                  <i
                    style={{
                      background: ["#b6b7d5", "#d6b684", "#7b9eb5", "#39806b"][
                        index
                      ],
                    }}
                  />
                  {row.strategy}
                </span>
              ))}
            </div>
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <BarChart3 size={18} />
            <h2>Strategy comparison</h2>
          </div>
          <Badge>{evaluation.scenario}</Badge>
        </div>
        <div className="table-scroll">
          <table className="evaluation-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Completed</th>
                <th>Avg. cost</th>
                <th>Mean quality</th>
                <th>Quality pass</th>
                <th>Constraints met</th>
                <th>P50 / P95 latency</th>
                <th>Router overhead</th>
                <th>Savings¹</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.rows.map((row) => (
                <tr
                  key={row.strategy}
                  className={row.strategy === "adaptive" ? "selected-row" : ""}
                >
                  <td>
                    <strong>{strategyLabel(row.strategy)}</strong>
                  </td>
                  <td>
                    {row.completed}/{row.submitted}
                    <small>{pct(row.completionRate)}</small>
                  </td>
                  <td>{money(row.averageCost, 5)}</td>
                  <td>
                    {row.meanQuality === null
                      ? "—"
                      : `${(row.meanQuality * 100).toFixed(1)}/100`}
                  </td>
                  <td>
                    {row.qualityPassRate === null
                      ? "—"
                      : pct(row.qualityPassRate)}
                  </td>
                  <td>{pct(row.constraintSatisfactionRate)}</td>
                  <td>
                    {row.p50Latency?.toFixed(1) ?? "—"}s /{" "}
                    {row.p95Latency?.toFixed(1) ?? "—"}s
                  </td>
                  <td>{row.routingOverheadMs.toFixed(2)} ms</td>
                  <td>{row.savings === null ? "—" : pct(row.savings)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          ¹ Savings compare the strongest strategy only when both strategies
          complete exactly the same prompts. Consider completion and quality
          alongside savings.
        </div>
        <div className="allocation-grid">
          {evaluation.rows.map((row) => (
            <div key={row.strategy}>
              <h4>{strategyLabel(row.strategy)} allocation</h4>
              {Object.entries(row.modelCounts).map(([model, count]) => (
                <p key={model}>
                  <span>{model}</span>
                  <strong>{count}</strong>
                </p>
              ))}
              {!Object.keys(row.modelCounts).length && (
                <p>No eligible completions</p>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
