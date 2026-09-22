import { chromium } from "playwright-core";

import { startDemoServer } from "../web/demo/server.js";

const args = process.argv.slice(2);
function arg(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const dataDir = arg("--data-dir");
if (!dataDir) throw new Error("--data-dir is required");
const delayMs = Number(arg("--delay-ms", "0"));
const bandwidthMiBps = Number(arg("--bandwidth-mibps", "0"));
const includeMetadata = args.includes("--metadata");
const chromePath = arg("--chrome", process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const defaultQueries = [
  'copernicus AND climate',
  'climate OR atmosphere OR "greenhouse gas" OR CO2',
  'copernicus AND (climate OR atmosphere OR "greenhouse gas" OR CO2)',
  'climate OR atmosphere OR co2 OR copernicus OR emissions OR energy OR environment OR temperature OR satellite OR "greenhouse gas"',
  '"greenhouse gas"',
];
const queries = arg("--only", null) ? [arg("--only", null)] : defaultQueries;

const server = await startDemoServer({ dataDir, delayMs });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  for (const query of queries) {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (bandwidthMiBps > 0) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: 0,
        downloadThroughput: bandwidthMiBps * 1024 * 1024,
        uploadThroughput: bandwidthMiBps * 1024 * 1024,
      });
    }
    await page.goto(`http://127.0.0.1:${server.address().port}/${includeMetadata ? "?titles=1" : ""}`);
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Ready");
    await page.locator("#query").fill(query);
    const started = performance.now();
    await page.locator("#search-form button").click();
    await page.waitForFunction(() => /results in|Search failed/.test(document.querySelector("#status").textContent), null, { timeout: 120_000 });
    const status = await page.locator("#status").textContent();
    const ids = await page.locator("#results li strong").allTextContents();
    console.log(JSON.stringify({ query, wallMs: Math.round(performance.now() - started), status, hits: ids.length, firstIds: ids.slice(0, 5) }));
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
