import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
const probe = createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((r) => probe.close(() => r()));
const inference = createHttpServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        response: "Mock local response for browser integration testing.",
        done: true,
        prompt_eval_count: 30,
        eval_count: 12,
      }),
    );
  });
});
await new Promise<void>((resolve) => inference.listen(0, "127.0.0.1", resolve));
const inferencePort = (inference.address() as { port: number }).port;
const temp = mkdtempSync(join(tmpdir(), "orchestra-browser-"));
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    env: {
      ...process.env,
      ORCHESTRA_DB_PATH: join(temp, "test.sqlite"),
      // Next would otherwise load a developer's .env.local and use a real gateway.
      ORCHESTRA_POOL: "",
      OLLAMA_MODEL: "browser-fixture",
      OLLAMA_BASE_URL: `http://127.0.0.1:${inferencePort}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
server.stdout.on("data", (d) => {
  log += d;
});
server.stderr.on("data", (d) => {
  log += d;
});
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    (existsSync("/usr/bin/google-chrome")
      ? "/usr/bin/google-chrome"
      : undefined),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
mkdirSync("test-results", { recursive: true });
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try {
      const r = await fetch(base + "/api/workspace");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error("Server did not start: " + log);
  await page.goto(base);
  await expect(page.locator(".selection-banner")).toContainText("Atlas Pro");
  const state0 = await page.request
    .get(base + "/api/workspace")
    .then((r) => r.json());
  expect(state0.history).toHaveLength(0);
  const calculator = page.getByRole("region", {
    name: "Live budget calculator",
  });
  const companyPolicy = page.getByRole("region", {
    name: "Company policy settings",
  });
  const calculation = page.getByRole("region", {
    name: "Agent1 live calculation",
  });
  /** The calculation lives under Evaluation; the request is edited in Request lab. */
  async function inEvaluation(check: () => Promise<void>) {
    await page.getByRole("button", { name: "Evaluation", exact: true }).click();
    await check();
    await page.getByRole("button", { name: /Request lab/ }).click();
  }
  async function currentPolicy() {
    const text = await page
      .locator(".policy-panel pre")
      .textContent()
      .catch(() => null);
    return text ? JSON.parse(text) : null;
  }
  await expect(page.locator(".policy-panel")).not.toContainText(
    "How this policy is calculated",
  );
  await inEvaluation(() =>
    expect(calculation.locator(".importance-comparison tbody tr")).toHaveCount(
      3,
    ),
  );
  await page.getByLabel("Importance", { exact: true }).selectOption("high");
  await expect
    .poll(async () => (await currentPolicy())?.calculation.multiplier)
    .toBe(2);
  await inEvaluation(() =>
    expect(calculation.locator('tr[aria-current="true"]')).toContainText(
      /high/i,
    ),
  );
  await page.getByLabel("Importance", { exact: true }).selectOption("low");
  await expect
    .poll(async () => (await currentPolicy())?.calculation.multiplier)
    .toBe(1);
  await page.getByLabel("Importance", { exact: true }).selectOption("medium");
  await companyPolicy.getByLabel("High importance multiplier").fill("2.6");
  await companyPolicy.getByLabel("Medium importance multiplier").fill("2.2");
  await expect
    .poll(async () => (await currentPolicy())?.calculation.multiplier)
    .toBe(2.2);
  await expect(
    page.getByRole("button", { name: "Run simulation" }),
  ).toBeDisabled();
  await calculator
    .getByLabel("Monthly budget ($)", { exact: true })
    .fill("1500");
  await expect
    .poll(async () => (await currentPolicy())?.budget.monthlyBudget)
    .toBe(1500);
  await expect
    .poll(async () => (await currentPolicy())?.calculation.multiplier)
    .toBe(2.2);
  await calculator.getByRole("button", { name: "Save budget" }).click();
  await expect(
    companyPolicy.getByLabel("Medium importance multiplier"),
  ).toHaveValue("2.2");
  await expect
    .poll(async () => (await currentPolicy())?.calculation.multiplier)
    .toBe(2.2);
  const draftState = await page.request
    .get(base + "/api/workspace")
    .then((r) => r.json());
  expect(draftState.settings.monthlyBudget).toBe(1500);
  expect(draftState.settings.companyPolicy.mediumMultiplier).toBe(1.5);
  expect(draftState.history).toHaveLength(0);
  expect(draftState.balances.simulation.spent).toBe(
    state0.balances.simulation.spent,
  );
  await calculator
    .getByLabel("Monthly budget ($)", { exact: true })
    .fill("1700");
  await expect
    .poll(async () => (await currentPolicy())?.budget.monthlyBudget)
    .toBe(1700);
  await companyPolicy
    .getByRole("button", { name: "Save company policy" })
    .click();
  await expect(
    page.getByRole("button", { name: "Run simulation" }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    companyPolicy.getByLabel("Medium importance multiplier"),
  ).toHaveValue("2.2");
  await expect(
    calculator.getByLabel("Monthly budget ($)", { exact: true }),
  ).toHaveValue("1700");
  await expect
    .poll(async () => (await currentPolicy())?.calculation.multiplier)
    .toBe(2.2);
  await companyPolicy.getByLabel("Cost pressure strength").fill("");
  await expect(companyPolicy).toContainText(
    "Fill in every company policy setting",
  );
  await inEvaluation(() => expect(calculation).toHaveCount(0));
  await expect(
    page.getByRole("button", { name: "Run simulation" }),
  ).toBeDisabled();
  await companyPolicy.getByLabel("Cost pressure strength").fill("2");
  await companyPolicy.getByLabel("High importance multiplier").fill("1");
  await expect(companyPolicy).toContainText(
    "High importance must be at least Medium",
  );
  await companyPolicy
    .getByRole("button", { name: "Reset to defaults" })
    .click();
  await expect
    .poll(async () => (await currentPolicy())?.calculation.multiplier)
    .toBe(1.5);
  const notReset = await page.request
    .get(base + "/api/workspace")
    .then((r) => r.json());
  expect(notReset.settings.companyPolicy.mediumMultiplier).toBe(2.2);
  await companyPolicy
    .getByRole("button", { name: "Save company policy" })
    .click();
  await page.getByRole("button", { name: "Advanced preferences" }).click();
  await page
    .getByLabel("Maximum request cost ($)", { exact: true })
    .fill("0.00001");
  await inEvaluation(async () => {
    await expect(calculation).toContainText(
      "The allowance is unchanged across importance levels",
    );
    await expect(calculation).toContainText("Explicit request cap");
  });
  const noSpend = await page.request
    .get(base + "/api/workspace")
    .then((r) => r.json());
  expect(noSpend.history).toHaveLength(0);
  expect(noSpend.balances.simulation.spent).toBe(
    state0.balances.simulation.spent,
  );
  await page.request.post(base + "/api/workspace", { data: state0.settings });
  await page.reload();
  await expect(page.locator(".selection-banner")).toContainText("Atlas Pro");
  await calculator
    .getByLabel("Monthly budget ($)", { exact: true })
    .fill("2000");
  await calculator
    .getByLabel("Starting spend this month ($)", { exact: true })
    .fill("500");
  await calculator.getByLabel("As-of date").fill("2026-10-16");
  await expect
    .poll(async () => {
      const text = await page
        .locator(".policy-panel pre")
        .textContent()
        .catch(() => null);
      return text ? JSON.parse(text).budget.monthlyBudget : null;
    })
    .toBe(2000);
  await expect(
    page.getByRole("region", { name: "Budget overview" }),
  ).toContainText("$1,500.00");
  const unsaved = await page.request
    .get(base + "/api/workspace")
    .then((r) => r.json());
  expect(unsaved.settings.monthlyBudget).toBe(state0.settings.monthlyBudget);
  expect(unsaved.history).toHaveLength(0);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByRole("button", { name: /Request lab/ }).click();
  await expect(
    calculator.getByLabel("Monthly budget ($)", { exact: true }),
  ).toHaveValue("2000");
  await expect(
    calculator.getByLabel("Starting spend this month ($)", { exact: true }),
  ).toHaveValue("500");
  await calculator.getByLabel("Monthly budget ($)", { exact: true }).fill("");
  await expect(calculator).toContainText("Fill in all four budget fields");
  await expect(
    page.getByRole("button", { name: "Run simulation" }),
  ).toBeDisabled();
  await expect(page.locator(".selection-banner")).toHaveCount(0);
  await calculator.getByLabel("Monthly budget ($)", { exact: true }).fill("0");
  await expect(page.locator(".selection-banner")).toContainText(
    "Your guardrails cannot currently be met",
  );
  await calculator
    .getByLabel("Monthly budget ($)", { exact: true })
    .fill("3000");
  await calculator
    .getByLabel("Monthly budget ($)", { exact: true })
    .fill("2000");
  await expect
    .poll(async () => {
      const text = await page
        .locator(".policy-panel pre")
        .textContent()
        .catch(() => null);
      return text ? JSON.parse(text).budget.monthlyBudget : null;
    })
    .toBe(2000);
  await calculator.getByRole("button", { name: "Save budget" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Workspace settings saved",
  );
  await page.reload();
  await expect(
    calculator.getByLabel("Monthly budget ($)", { exact: true }),
  ).toHaveValue("2000");
  await page.request.post(base + "/api/workspace", { data: state0.settings });
  await page.reload();
  await expect(page.locator(".selection-banner")).toContainText("Atlas Pro");
  await page.screenshot({
    path: "test-results/request-lab.png",
    fullPage: true,
  });
  await page.getByRole("slider", { name: /Minimum quality/ }).fill("99");
  await expect(page.locator(".selection-banner")).toContainText(
    "Your guardrails cannot currently be met",
  );
  await page.getByRole("slider", { name: /Minimum quality/ }).fill("72");
  await page.getByRole("button", { name: /Tight budget.*92%/ }).click();
  await expect(page.getByRole("status")).toContainText(
    "Budget scenario updated",
  );
  await page.getByRole("button", { name: "Preview routing" }).click();
  await expect(page.locator(".selection-banner")).toContainText("Spark Mini");
  const before = await page.request
    .get(base + "/api/workspace")
    .then((r) => r.json());
  expect(before.history).toHaveLength(0);
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(
    page.getByRole("heading", { name: "Simulated response" }),
  ).toBeVisible();
  await expect(page.locator(".response-text")).toContainText(
    "no language model was called",
  );
  const after = await page.request
    .get(base + "/api/workspace")
    .then((r) => r.json());
  expect(after.history).toHaveLength(1);
  expect(after.balances.simulation.spent).toBeGreaterThan(
    before.balances.simulation.spent,
  );
  expect(after.history[0].actualCost).toBe(0);
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    // Exercise a pre-v1.1 historical snapshot without rewriting the database.
    data.history[0].preview.policy.version = "1.0";
    delete data.history[0].preview.policy.calculation;
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await page.getByRole("button", { name: /Run history/ }).click();
  await page.locator(".history-item").first().click();
  await expect(
    page.getByRole("heading", { name: "Simulated response" }),
  ).toBeVisible();
  await expect(page.locator(".policy-panel")).toContainText(
    "This historical v1.0 policy has no calculation trace",
  );
  await page.unroute("**/api/workspace");
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Class project studio");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Workspace settings saved",
  );
  await page.reload();
  await expect(page.locator(".workspace-switch")).toContainText(
    "Class project studio",
  );
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(
    page.getByRole("heading", { name: "Strategy comparison" }),
  ).toBeVisible();
  await expect(page.locator(".evaluation-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".benchmark-prompt")).toHaveCount(40);
  await page
    .getByRole("button", { name: "Held-out evaluation", exact: true })
    .click();
  await expect(page.locator(".benchmark-prompt")).toHaveCount(20);
  await page.screenshot({
    path: "test-results/evaluation.png",
    fullPage: true,
  });
  const exported = await page.request.get(base + "/api/export?format=csv");
  expect(exported.ok()).toBeTruthy();
  expect(await exported.text()).toContain("simulated_cost_usd");
  const invalid = await page.request.post(base + "/api/preview", {
    data: { input: { prompt: "" } },
  });
  expect(invalid.status()).toBe(400);
  const foreign = await page.request.post(base + "/api/preview", {
    headers: { Origin: "https://example.com" },
    data: { input: state0.defaultInput },
  });
  expect(foreign.status()).toBe(403);
  const key = randomUUID();
  const one = await page.request
    .post(base + "/api/run", {
      data: { input: state0.defaultInput, idempotencyKey: key },
    })
    .then((r) => r.json());
  const two = await page.request
    .post(base + "/api/run", {
      data: { input: state0.defaultInput, idempotencyKey: key },
    })
    .then((r) => r.json());
  expect(one.id).toBe(two.id);
  await page.getByRole("button", { name: /Request lab/ }).click();
  await page.getByLabel("Execution mode").selectOption("local");
  await page.getByRole("slider", { name: /Minimum quality/ }).fill("0");
  await page.getByRole("button", { name: "Preview routing" }).click();
  await expect(page.locator(".selection-banner")).toContainText(
    "browser-fixture",
  );
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Run comparison" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Calibration split", exact: true })
    .click();
  await page.locator(".benchmark-prompt summary").first().click();
  await page
    .getByRole("button", { name: "Load in request lab" })
    .first()
    .click();
  await page.getByRole("button", { name: "Run locally" }).click();
  await expect(
    page.getByRole("heading", { name: "Local model response" }),
  ).toBeVisible();
  await expect(page.locator(".response-text")).toContainText(
    "Mock local response",
  );
  await page.getByRole("button", { name: /Run history/ }).click();
  await page.locator(".history-item").first().click();
  await page.getByRole("button", { name: "Save rating" }).click();
  await expect(page.getByRole("status")).toContainText("Rating saved");
  const rated = await page.request
    .get(base + "/api/workspace")
    .then((r) => r.json());
  expect(
    rated.models.find((m: { local: boolean }) => m.local).sampleCount,
  ).toBe(1);
  expect(rated.balances.local.spent).toBe(0);
  await page.getByRole("button", { name: /Request lab/ }).click();
  await page.getByLabel("Execution mode").selectOption("simulation");
  await calculator
    .getByLabel("Monthly budget ($)", { exact: true })
    .fill("3000");
  await calculator
    .getByLabel("Starting spend this month ($)", { exact: true })
    .fill("100");
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(
    page.getByRole("heading", { name: "Simulated response" }),
  ).toBeVisible();
  const savedRun = await page.request
    .get(base + "/api/workspace")
    .then((r) => r.json());
  expect(savedRun.settings.monthlyBudget).toBe(3000);
  expect(savedRun.settings.openingSpend).toBe(100);
  expect(savedRun.history[0].preview.policy.budget.monthlyBudget).toBe(3000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /Request lab/ }).click();
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
  console.log(
    "Browser checks passed: company policy drafts/save/reset, live formulas and importance comparisons, binding-limit explanations, legacy history, live budget edits, draft merging, save-on-run, desktop/mobile layout, hard constraints, scenario routing, settings persistence, 40-prompt library, evaluation, export, invalid input, cross-origin guard, idempotency, mocked local execution and calibration ratings. Screenshots: test-results/",
  );
} catch (error) {
  await page
    .screenshot({ path: "test-results/failure.png", fullPage: true })
    .catch(() => {});
  console.error(log);
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((resolve) => inference.close(() => resolve()));
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (server.exitCode !== null) resolve();
    else {
      server.once("exit", () => resolve());
      setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    }
  });
}
