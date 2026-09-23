import { chromium } from "playwright-core";

const manifest = "https://huggingface.co/datasets/do-me/EUR-LEX/resolve/search-index/search/roaring/v1/manifest.json";
const base = process.env.DEMO_URL || "http://127.0.0.1:8123/";
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const started = performance.now();
  await page.goto(`${base}?manifest=${encodeURIComponent(manifest)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Ready", null, { timeout: 30000 });
  if (process.env.THEME) await page.getByRole("button", { name: process.env.THEME, exact: false }).click();
  await page.locator("#query").fill("copernicus AND clms");
  await page.locator("#year-from").fill("1973");
  await page.waitForFunction(() => {
    const state = new URL(location.href).searchParams;
    return state.get("q") === "copernicus AND clms" && state.get("from") === "1973";
  });
  await page.locator("#search-form button").click();
  await page.waitForFunction(() => document.querySelector("#search-form button[type=submit]")?.disabled === false, null, { timeout: 30000 });
  const searchStatus = await page.locator("#status").textContent();
  const searchMs = performance.now() - started;
  if (!await page.locator("#prepare-analysis").count()) {
    const alerts = await page.getByRole("alert").allTextContents();
    await page.screenshot({ path: "/tmp/roaring-analysis-production.png", fullPage: true });
    throw new Error(`Search produced no analysable rows: ${searchStatus}; alerts=${JSON.stringify(alerts)}; errors=${JSON.stringify(errors)}`);
  }
  await page.locator("#prepare-analysis").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("rows loaded"), null, { timeout: 120000 });
  const analysisStatus = await page.locator("#analysis-status").textContent();
  const analysisMs = performance.now() - started;
  await page.locator("#sql").fill("SELECT count(*) AS documents, min(date) AS first_date, max(date) AS last_date FROM search_results");
  await page.locator("#run-sql").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("preview rows"));
  const cells = await page.locator('[aria-labelledby="analysis-title"] tbody td').allTextContents();
  await page.screenshot({ path: "/tmp/roaring-analysis-production.png", fullPage: true });
  console.log(JSON.stringify({ searchStatus, analysisStatus, cells, searchMs: Math.round(searchMs), analysisMs: Math.round(analysisMs), errors }, null, 2));
} finally {
  await browser.close();
}
