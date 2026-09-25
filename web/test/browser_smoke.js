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
  const paginationJsonl = path.join(dataDir, "pagination.jsonl");
  await writeFile(paginationJsonl, Array.from({ length: 125 }, (_, index) => JSON.stringify({
    id: `PAGE-${String(index + 1).padStart(3, "0")}`,
    title: `Pagination row ${index + 1}`,
    text: `pagination fixture document ${index + 1}`,
  })).join("\n") + "\n");
  execFileSync("uv", ["run", "roaring-static-search", "build", "--jsonl", paginationJsonl,
    "--out", path.join(dataDir, "pagination/shard"), "--metadata-fields", "title"], { cwd: root });
  execFileSync("uv", ["run", "roaring-static-search", "manifest", "--out", path.join(dataDir, "pagination/manifest.json"),
    "pagination=shard/shard.json"], { cwd: root });
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
  await page.getByRole("button", { name: "Dark" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.evaluate(() => localStorage.getItem("eur-lex-theme")), "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "Auto" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("button", { name: "Light" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.locator("#search-form button").click();
  try { await page.locator('#results td[aria-colindex="3"]').first().waitFor({ timeout: 5000 }); }
  catch (error) { throw new Error(`${error.message}; status=${await page.locator("#status").textContent()}; errors=${JSON.stringify(errors)}`); }
  await page.waitForFunction(() => [...document.querySelectorAll('#results td[aria-colindex="3"]')].map((cell) => cell.textContent).join(",") === "A,H");
  assert.deepEqual(await page.locator('#results td[aria-colindex="3"]').allTextContents(), ["A", "H"]);
  await page.locator("#prepare-analysis").click();
  try { await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("rows loaded"), null, { timeout: 20000 }); }
  catch (error) { throw new Error(`${error.message}; analysis=${await page.locator("#analysis-status").textContent()}; alerts=${JSON.stringify(await page.getByRole("alert").allTextContents())}; errors=${JSON.stringify(errors)}`); }
  await page.locator("#sql").fill("SELECT celex, title FROM search_results ORDER BY celex");
  await page.waitForFunction(() => new URL(location.href).searchParams.get("sql") === "SELECT celex, title FROM search_results ORDER BY celex");
  await page.locator("#run-sql").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("2 preview rows"));
  assert.deepEqual(await page.locator('[aria-labelledby="analysis-title"] tbody td:first-child').allTextContents(), ["A", "H"]);
  assert.equal(await page.locator("#sql-chart-title").textContent(), "Chart this SQL output");
  assert.equal(await page.locator("#create-sql-chart").count(), 0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.csv$/);
  assert.match(await readFile(await download.path(), "utf8"), /celex,title[\s\S]*A/);
  await page.getByRole("button", { name: "Download Parquet" }).waitFor({ state: "visible" });
  const parquetPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Parquet" }).click();
  const parquet = await parquetPromise;
  assert.match(parquet.suggestedFilename(), /\.parquet$/);
  const parquetBytes = await readFile(await parquet.path());
  assert.equal(parquetBytes.subarray(0, 4).toString(), "PAR1");
  assert.equal(parquetBytes.subarray(-4).toString(), "PAR1");
  const excelPromise = page.waitForEvent("download", { timeout: 5000 });
  await page.getByRole("button", { name: "Download Excel" }).click();
  let excel;
  try { excel = await excelPromise; }
  catch (error) { throw new Error(`${error.message}; analysis=${await page.locator("#analysis-status").textContent()}; alerts=${JSON.stringify(await page.getByRole("alert").allTextContents())}; errors=${JSON.stringify(errors)}`); }
  assert.match(excel.suggestedFilename(), /\.xlsx$/);
  const excelPath = await excel.path();
  const excelBytes = await readFile(excelPath);
  assert.equal(excelBytes.subarray(0, 2).toString(), "PK");
  execFileSync("unzip", ["-t", excelPath], { stdio: "ignore" });
  await page.locator("#sql").fill("SELECT celex AS label, _search_rank AS rank, length(text) AS chars FROM search_results ORDER BY rank");
  assert.equal(await page.locator("#sql-chart-title").count(), 0);
  await page.locator("#run-sql").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("2 preview rows"));
  assert.equal(await page.locator("#chart-x").inputValue(), "label");
  await page.locator("#chart-y").selectOption("chars");
  await page.locator("#create-sql-chart").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("2 bars"));
  assert.equal(await page.locator('[aria-labelledby="sql-chart-title"] svg rect').count(), 2);
  const chartTitles = await page.locator('[aria-labelledby="sql-chart-title"] svg rect title').allTextContents();
  assert.match(chartTitles[0], /^A: \d+$/);
  assert.match(chartTitles[1], /^H: \d+$/);
  assert.equal(await page.locator("#chart-values").isChecked(), true);
  await page.locator("#chart-values").uncheck();
  await page.locator("#sql").fill("SELECT range AS year, range AS documents FROM range(0, 250)");
  await page.locator("#run-sql").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("200 preview rows"));
  assert.equal(await page.locator("#chart-x").inputValue(), "year");
  assert.equal(await page.locator("#chart-y").inputValue(), "documents");
  await page.locator("#create-sql-chart").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("250 bars"));
  assert.equal(await page.locator('[aria-labelledby="sql-chart-title"] svg rect').count(), 250);
  await page.locator("#sql").fill("SELECT range AS year, range AS documents FROM range(0, 501)");
  await page.locator("#run-sql").click();
  await page.waitForFunction(() => document.querySelector("#analysis-status")?.textContent.includes("200 preview rows"));
  await page.locator("#create-sql-chart").click();
  await page.getByRole("alert").filter({ hasText: "more than 500 rows" }).waitFor();
  await page.locator("#query").fill('"greenhouse gas"');
  await page.locator("#search-form button").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("3 shown"));
  assert.deepEqual(await page.locator('#results td[aria-colindex="3"]').allTextContents(), ["A", "F", "H"]);
  await page.locator("#query").fill("climate");
  await page.locator("#year-from").fill("2026");
  await page.locator("#year-to").fill("2026");
  await page.locator("#scope-all").check();
  assert.equal(await page.locator("#deduplicate").isChecked(), true);
  await page.locator("#search-form button").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("2 shown"));
  assert.equal(await page.locator("#timeline-title").textContent(), "Matches by year");
  assert.deepEqual(await page.locator('[aria-labelledby="timeline-title"] .bar-value').allTextContents(), ["2"]);
  await page.waitForFunction(() => [...document.querySelectorAll('#results td[aria-colindex="3"]')].map((cell) => cell.textContent).join(",") === "G,H");
  assert.deepEqual(await page.locator('#results td[aria-colindex="3"]').allTextContents(), ["G", "H"]);
  await page.locator("#deduplicate").uncheck();
  await page.waitForFunction(() => {
    const state = new URL(location.href).searchParams;
    return state.get("q") === "climate" && state.get("from") === "2026" && state.get("to") === "2026"
      && state.get("all") === "1" && state.get("dedupe") === "0"
      && state.get("sql") === "SELECT range AS year, range AS documents FROM range(0, 501)";
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Ready");
  assert.equal(await page.locator("#query").inputValue(), "climate");
  assert.equal(await page.locator("#year-from").inputValue(), "2026");
  assert.equal(await page.locator("#year-to").inputValue(), "2026");
  assert.equal(await page.locator("#scope-all").isChecked(), true);
  assert.equal(await page.locator("#deduplicate").isChecked(), false);
  await page.goto(`http://127.0.0.1:${server.address().port}/?manifest=/data/pagination/manifest.json`);
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Ready");
  await page.locator("#query").fill("pagination");
  await page.locator("#search-form button[type=submit]").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("50 shown"));
  const resultScroller = page.locator('#results [role="group"][aria-labelledby="caption"]');
  await resultScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("100 shown"));
  assert.ok(await resultScroller.evaluate((element) => element.scrollTop > 0));
  await resultScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("125 shown"));
  assert.equal(await page.locator("#more").count(), 0);
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
  console.log("Chrome browser smoke test passed: themes, search modes, automatic pagination, URL state, valid SQL exports, configurable SQL chart and limit, timeline labels, errors, and Parquet hydration");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
