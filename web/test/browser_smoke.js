import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
  execFileSync("npm", ["run", "build:demo"], { cwd: root });
  server = await startDemoServer({ dataDir });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Ready");
  await page.locator("#search-form button").click();
  try { await page.locator("#results li").first().waitFor({ timeout: 5000 }); }
  catch (error) { throw new Error(`${error.message}; status=${await page.locator("#status").textContent()}; errors=${JSON.stringify(errors)}`); }
  assert.deepEqual(await page.locator("#results li strong").allTextContents(), ["A", "H"]);
  await page.locator("#query").fill('"greenhouse gas"');
  await page.locator("#search-form button").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("bitmap candidates"));
  assert.deepEqual(await page.locator("#results li strong").allTextContents(), ["A", "F", "H"]);
  assert.deepEqual(errors, []);
  console.log("Chrome browser smoke test passed: exact nested query and phrase verification");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
