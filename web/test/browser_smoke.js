import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { startDemoServer } from "../demo/server.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dataDir = await mkdtemp(path.join(os.tmpdir(), "roaring-static-browser-"));
let server;
let browser;
try {
  for (const shard of ["archive", "current"]) {
    execFileSync("uv", ["run", "roaring-static-search", "build", "--jsonl", path.join(root, "tests/fixtures", `${shard}.jsonl`), "--out", path.join(dataDir, shard), "--metadata-fields", "title"], { cwd: root });
  }
  execFileSync("uv", ["run", "roaring-static-search", "manifest", "--out", path.join(dataDir, "manifest.json"), "archive=archive/shard.json", "current=current/shard.json"], { cwd: root });
  const manifestPath = path.join(dataDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  Object.assign(manifest.shards[0], { yearStart: 2020, yearEnd: 2020 });
  Object.assign(manifest.shards[1], { yearStart: 2026, yearEnd: 2026 });
  await writeFile(manifestPath, JSON.stringify(manifest));
  execFileSync("npm", ["run", "build:demo"], { cwd: root });
  server = await startDemoServer({ dataDir });
  const sourceFile = path.join(dataDir, "source/files/example.parquet");
  execFileSync("uv", ["run", "--extra", "parquet", "python", "tests/create_parquet_fixture.py", sourceFile], { cwd: root });
  execFileSync("uv", ["run", "--extra", "parquet", "roaring-static-search", "build", "--parquet-glob", sourceFile,
    "--out", path.join(dataDir, "external"), "--id-field", "celex", "--metadata-fields", "title",
    "--external-parquet-text", "--source-root", path.join(dataDir, "source"),
    "--source-base-url", `http://127.0.0.1:${server.address().port}/data/source/`], { cwd: root });
  execFileSync("uv", ["run", "roaring-static-search", "manifest", "--out", path.join(dataDir, "external/manifest.json"),
    "external=shard.json"], { cwd: root });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Ready");
  await page.locator("#search-form button").click();
  try { await page.locator('#results td[aria-colindex="3"]').first().waitFor({ timeout: 5000 }); }
  catch (error) { throw new Error(`${error.message}; status=${await page.locator("#status").textContent()}; errors=${JSON.stringify(errors)}`); }
  assert.deepEqual(await page.locator('#results td[aria-colindex="3"]').allTextContents(), ["A", "H"]);
  await page.locator("#prepare-analysis").click();
  try { await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("rows loaded"), null, { timeout: 20000 }); }
  catch (error) { throw new Error(`${error.message}; analysis=${await page.locator("#analysis-status").textContent()}; alerts=${JSON.stringify(await page.getByRole("alert").allTextContents())}; errors=${JSON.stringify(errors)}`); }
  await page.locator("#sql").fill("SELECT celex, title FROM search_results ORDER BY celex");
  await page.locator("#run-sql").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("2 preview rows"));
  assert.deepEqual(await page.locator('[aria-labelledby="analysis-title"] tbody td:first-child').allTextContents(), ["A", "H"]);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.csv$/);
  await page.getByRole("button", { name: "Download Parquet" }).waitFor({ state: "visible" });
  const parquetPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Parquet" }).click();
  assert.match((await parquetPromise).suggestedFilename(), /\.parquet$/);
  const excelPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name: "Download Excel" }).click();
  assert.match((await excelPromise).suggestedFilename(), /\.xlsx$/);
  await page.locator("#query").fill('"greenhouse gas"');
  await page.locator("#search-form button").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("3 shown"));
  assert.deepEqual(await page.locator('#results td[aria-colindex="3"]').allTextContents(), ["A", "F", "H"]);
  await page.locator("#query").fill("climate");
  await page.locator("#year-from").fill("2026");
  await page.locator("#year-to").fill("2026");
  await page.locator("#search-all").check();
  assert.equal(await page.locator("#deduplicate").isChecked(), true);
  await page.locator("#search-form button").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("2 shown"));
  assert.equal(await page.locator("#timeline-title").textContent(), "Matches by year");
  await page.waitForFunction(() => [...document.querySelectorAll('#results td[aria-colindex="3"]')].map((cell) => cell.textContent).join(",") === "G,H");
  assert.deepEqual(await page.locator('#results td[aria-colindex="3"]').allTextContents(), ["G", "H"]);
  await page.goto(`http://127.0.0.1:${server.address().port}/?manifest=/data/external/manifest.json`);
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Ready");
  await page.locator("#query").fill('"greenhouse gas"');
  await page.locator("#search-form button").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("1 shown"));
  assert.deepEqual(await page.locator('#results td[aria-colindex="3"]').allTextContents(), ["P1"]);
  await page.waitForFunction(() => document.querySelector("#hydration-status").textContent.includes("requests"));
  assert.equal(await page.locator('#results td[aria-colindex="5"]').first().textContent(), "Exact phrase");
  await page.goto(`http://127.0.0.1:${server.address().port}/?manifest=/data/missing.json`);
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").textContent(), /HTTP 404/);
  assert.equal(await page.getByRole("button", { name: "Retry" }).isVisible(), true);
  assert.deepEqual(errors.filter((message) => !message.includes("/data/missing.json") && !message.match(/duckdb-(?:eh|mvp).*\.wasm: net::ERR_ABORTED/)), []);
  console.log("Chrome browser smoke test passed: search, SQL analysis, CSV/Parquet/Excel exports, chart, errors, and Parquet hydration");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
