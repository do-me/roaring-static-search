import { chromium } from "playwright-core";

import { startDemoServer } from "../web/demo/server.js";

const args = process.argv.slice(2);
function arg(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const dataDir = arg("--data-dir");
if (!dataDir) throw new Error("--data-dir is required");
const delayMs = Number(arg("--delay-ms", "0"));
const bandwidthMiBps = Number(arg("--bandwidth-mibps", "0"));
const includeMetadata = args.includes("--metadata");
const sourceMap = arg("--source-map", null);
const sourceBase = arg("--source-base", null);
const sourceDir = arg("--source-dir", null);
const sourceShard = arg("--source-shard", "archive");
const sourceMode = arg("--source-mode", "whole");
const sourceConcurrency = arg("--source-concurrency", "8");
const verifyBatch = arg("--verify-batch", "64");
const chromePath = arg("--chrome", process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const defaultQueries = [
  'copernicus AND climate',
  'climate OR atmosphere OR "greenhouse gas" OR CO2',
  'copernicus AND (climate OR atmosphere OR "greenhouse gas" OR CO2)',
  'climate OR atmosphere OR co2 OR copernicus OR emissions OR energy OR environment OR temperature OR satellite OR "greenhouse gas"',
  '"greenhouse gas"',
];
const queries = arg("--only", null) ? [arg("--only", null)] : defaultQueries;

const server = await startDemoServer({ dataDir, sourceDir, delayMs });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  for (const query of queries) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on("pageerror", (error) => errors.push(error.message));
    if (bandwidthMiBps > 0) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: 0,
        downloadThroughput: bandwidthMiBps * 1024 * 1024,
        uploadThroughput: bandwidthMiBps * 1024 * 1024,
      });
    }
    const url = new URL(`http://127.0.0.1:${server.address().port}/`);
    if (includeMetadata) url.searchParams.set("titles", "1");
    url.searchParams.set("verifyBatch", verifyBatch);
    if (sourceMap) {
      url.searchParams.set("sourceMap", sourceMap);
      url.searchParams.set("sourceShard", sourceShard);
      url.searchParams.set("sourceBase", sourceBase || `${url.origin}/source/`);
      url.searchParams.set("sourceMode", sourceMode);
      url.searchParams.set("sourceConcurrency", sourceConcurrency);
    }
    const navigationStarted = performance.now();
    await page.goto(url.href);
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Ready");
    const readyMs = Math.round(performance.now() - navigationStarted);
    await page.locator("#query").fill(query);
    const started = performance.now();
    await page.locator("#search-form button").click();
    await page.waitForFunction(() => /results in|Search failed/.test(document.querySelector("#status").textContent), null, { timeout: 120_000 });
    const status = await page.locator("#status").textContent();
    const ids = await page.locator("#results li strong").allTextContents();
    console.log(JSON.stringify({ query, readyMs, wallMs: Math.round(performance.now() - started), status, hits: ids.length, firstIds: ids.slice(0, 5), ...(errors.length ? { errors } : {}) }));
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
