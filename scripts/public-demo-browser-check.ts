import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
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
      VERCEL: "1",
      ORCHESTRA_DB_PATH: "/var/task/data/forbidden.sqlite",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
server.stdout.on("data", (data) => (log += data));
server.stderr.on("data", (data) => (log += data));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(log);
    try {
      if ((await fetch(base + "/api/workspace")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error(log);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH || (existsSync(chrome) ? chrome : undefined),
    headless: true,
  });
  const visitorA = await browser.newContext(),
    visitorB = await browser.newContext();
  const page = await visitorA.newPage();
  const errors: string[] = [],
    writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET")
      writes.push(request.url());
  });
  await page.goto(base);
  await expect(page.getByRole("note")).toContainText("Public simulation demo");
  await expect(page.getByLabel("Importance mode", { exact: true })).toHaveValue(
    "inferred",
  );
  await page
    .locator(".prompt-input")
    .fill("Review a distributed production security incident");
  await expect(page.locator("#task-classification")).toContainText(
    "Inferred importance: high",
  );
  await page
    .getByLabel("Importance mode", { exact: true })
    .selectOption("fixed");
  await page.getByLabel("Importance", { exact: true }).selectOption("low");
  await expect(page.locator(".policy-panel")).toContainText(
    '"importance": "low"',
  );
  await page.getByRole("button", { name: /Run simulation/ }).click();
  await expect(page.locator(".response-panel")).toContainText(
    "SIMULATED EXECUTION",
  );
  await page.getByRole("button", { name: /Run history/ }).click();
  await expect(page.locator(".history-item")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Export workspace", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("orchestra-workspace.json");
  await page.reload();
  await expect(page.getByRole("note")).toContainText(
    "saved only in this browser",
  );
  await page.getByRole("button", { name: /Run history/ }).click();
  await expect(page.locator(".history-item")).toHaveCount(1);
  const other = await visitorB.newPage();
  await other.goto(base);
  await other.getByRole("button", { name: /Run history/ }).click();
  await expect(other.locator(".history-item")).toHaveCount(0);
  const defaults = await (
    await other.request.get(base + "/api/workspace")
  ).json();
  expect(defaults.history).toHaveLength(0);
  expect((await other.request.get(base + "/api/export")).status()).toBe(403);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  console.log(
    "Public demo browser checks passed: read-only deployment boot, automatic/manual classification, simulation, export, reload recovery, two-visitor isolation, and no workspace POST requests.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
