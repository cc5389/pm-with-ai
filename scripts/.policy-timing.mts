import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const page = await browser.newPage();
const log: string[] = [];
const t0 = Date.now();
page.on("request", (r) => r.url().includes("/api/") && log.push(`${Date.now() - t0}ms -> ${r.method()} ${new URL(r.url()).pathname}`));
page.on("response", (r) => r.url().includes("/api/") && log.push(`${Date.now() - t0}ms <- ${r.status()} ${new URL(r.url()).pathname}`));
await page.goto("http://127.0.0.1:3000/");
await page.getByText("Est. quality").first().waitFor({ timeout: 30000 });
const field = page.getByLabel("High importance multiplier");
for (const value of ["3", "2"]) {
  log.push(`--- set high multiplier ${value}`);
  const start = Date.now();
  await field.fill(value);
  await page.waitForResponse((r) => r.url().includes("/api/preview"), { timeout: 15000 });
  await page.getByText("Est. quality").first().waitFor();
  log.push(`preview visible after ${Date.now() - start}ms`);
  await page.waitForTimeout(500);
}
log.push("--- save company policy");
const s = Date.now();
await page.getByRole("button", { name: "Save company policy" }).click();
await page.getByText("Workspace settings saved").waitFor({ timeout: 15000 }).catch(() => log.push("no saved notice"));
await page.getByText("Est. quality").first().waitFor({ timeout: 15000 });
log.push(`saved and preview visible after ${Date.now() - s}ms`);
console.log(log.join("\n"));
await browser.close();
