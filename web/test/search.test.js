import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { StaticSearch, matchesText, parseQuery } from "../src/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
let temp;
let server;
let origin;
let search;

before(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "roaring-static-search-test-"));
  for (const shard of ["archive", "current"]) {
    execFileSync("uv", ["run", "roaring-static-search", "build", "--jsonl", path.join(root, "tests/fixtures", `${shard}.jsonl`), "--out", path.join(temp, shard), "--metadata-fields", "title"], { cwd: root });
  }
  execFileSync("uv", ["run", "roaring-static-search", "manifest", "--out", path.join(temp, "manifest.json"), "archive=archive/shard.json", "current=current/shard.json"], { cwd: root });
  const manifestPath = path.join(temp, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  Object.assign(manifest.shards[0], { yearStart: 2020, yearEnd: 2020 });
  Object.assign(manifest.shards[1], { yearStart: 2026, yearEnd: 2026 });
  await writeFile(manifestPath, JSON.stringify(manifest));
  server = createServer(async (request, response) => {
    const requested = path.join(temp, decodeURIComponent(new URL(request.url, "http://localhost").pathname));
    if (!requested.startsWith(temp + path.sep)) { response.writeHead(403).end(); return; }
    let bytes;
    try { bytes = await readFile(requested); } catch { response.writeHead(404).end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      response.writeHead(206, { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": end - start + 1 });
      response.end(bytes.subarray(start, end + 1));
    } else {
      response.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Length": bytes.length });
      response.end(bytes);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  search = new StaticSearch(`${origin}/manifest.json`);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
});

test("parser precedence and exact adjacent-token semantics", () => {
  const tree = parseQuery('copernicus AND (climate OR "greenhouse gas")');
  assert.equal(matchesText(tree, "Copernicus found greenhouse-gas."), true);
  assert.equal(matchesText(tree, "Copernicus found a greenhouse and some gas."), false);
  assert.throws(() => parseQuery('copernicus AND ('), SyntaxError);
});

test("Python portable bitmap is read by browser WASM, exact AND/OR across shards", async () => {
  const answer = await search.search('copernicus AND (climate OR atmosphere OR "greenhouse gas" OR CO2)');
  assert.deepEqual(answer.hits.map((hit) => hit.id), ["A", "D", "H"]);
  assert.equal(answer.candidateCount, 3);
  assert.equal(answer.exactCount, null);
  assert.equal(answer.verifiedTexts, 0);
  const plain = await search.search("copernicus AND climate");
  assert.deepEqual(plain.hits.map((hit) => hit.id), ["A", "H"]);
  assert.equal(plain.exactCount, 2);
  const document = await search.getDocument(plain.hits[0], { includeText: true });
  assert.match(document.text, /Copernicus observes climate/);
  const withMetadata = await search.search("copernicus AND climate", { includeMetadata: true });
  assert.equal(withMetadata.hits[0].title, "Climate observation");
});

test("phrase false positives are skipped without losing pagination", async () => {
  const first = await search.search('"greenhouse gas"', { limit: 1 });
  assert.deepEqual(first.hits.map((hit) => hit.id), ["A"]);
  assert.equal(first.exactCount, null);
  const second = await search.search('"greenhouse gas"', { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.hits.map((hit) => hit.id), ["F"]);
  const third = await search.search('"greenhouse gas"', { limit: 1, cursor: second.nextCursor });
  assert.deepEqual(third.hits.map((hit) => hit.id), ["H"]);
  const exhaustive = await search.search('"greenhouse gas"', { limit: 10, exhaustive: true });
  assert.equal(exhaustive.candidateCount, 4);
  assert.equal(exhaustive.exactCount, 3);
  assert.deepEqual(exhaustive.hits.map((hit) => hit.id), ["A", "F", "H"]);
});

test("Unicode tokens and mixed Boolean query", async () => {
  const answer = await search.search('café OR co2');
  assert.deepEqual(answer.hits.map((hit) => hit.id), ["C", "G"]);
});

test("year bounds skip unrelated shards and unlimited search returns every hit", async () => {
  const filtered = new StaticSearch(`${origin}/manifest.json`);
  assert.deepEqual(await filtered.yearBounds(), { min: 2020, max: 2026 });
  const answer = await filtered.search("climate", { yearFrom: 2026, yearTo: 2026, limit: null });
  assert.deepEqual(answer.hits.map((hit) => [hit.id, hit.year]), [["G", 2026], ["H", 2026]]);
  assert.equal(answer.exactCount, 2);
  assert.equal(filtered.shards[0], undefined, "the 2020 shard must not be loaded");
  assert.ok(filtered.shards[1], "the selected 2026 shard is loaded");
  await filtered.close();
});

test("exhaustive Boolean results agree with a full-text scan", async () => {
  const source = (await Promise.all(["archive", "current"].map(async (name) =>
    (await readFile(path.join(root, "tests/fixtures", `${name}.jsonl`), "utf8"))
      .trim().split("\n").map(JSON.parse)))).flat();
  const queries = [
    "copernicus", "climate AND atmosphere", "copernicus OR co2",
    '"greenhouse gas"', 'climate AND "greenhouse gas"',
    'copernicus AND (atmosphere OR "greenhouse gas")',
    '(climate OR co2) AND (copernicus OR atmosphere)',
    '"greenhouse gas" OR "café climate"',
  ];
  for (const query of queries) {
    const expected = source.filter((doc) => matchesText(parseQuery(query), doc.text)).map((doc) => doc.id);
    const actual = await search.search(query, { exhaustive: true });
    assert.deepEqual(actual.hits.map((hit) => hit.id), expected, query);
    assert.equal(actual.exactCount, expected.length, query);
  }
});

test("external Parquet text verifies phrases without a duplicate text store", async () => {
  const sourceFile = path.join(temp, "source/files/example.parquet");
  execFileSync("uv", ["run", "--extra", "parquet", "python", "tests/create_parquet_fixture.py", sourceFile], { cwd: root });
  const target = path.join(temp, "external");
  execFileSync("uv", ["run", "--extra", "parquet", "roaring-static-search", "build",
    "--parquet-glob", sourceFile, "--out", target, "--id-field", "celex",
    "--metadata-fields", "title", "--external-parquet-text", "--source-root", path.join(temp, "source"),
    "--source-base-url", `${origin}/source/`], { cwd: root });
  execFileSync("uv", ["run", "roaring-static-search", "manifest", "--out", path.join(target, "manifest.json"),
    "external=shard.json"], { cwd: root });
  assert.equal((await readFile(path.join(target, "text.bin"))).length, 0);
  const external = new StaticSearch(`${origin}/external/manifest.json`);
  const page = await external.search('"greenhouse gas"', { includeMetadata: true });
  assert.deepEqual(page.hits.map((hit) => hit.id), ["P1"]);
  assert.equal(page.candidateCount, 2);
  assert.equal(page.hits[0].title, "Exact phrase");
  assert.equal((await external.getDocument(page.hits[0], { includeText: true })).text, "Copernicus and greenhouse gas");
  const sourceRows = await external.getSourceRows(page.hits, {
    columns: ["celex", "url", "institutions", "eurovoc_concepts", "text"],
  });
  assert.deepEqual(sourceRows.rows, [{
    celex: "P1",
    url: "https://example.test/p1",
    institutions: ["European Commission"],
    eurovoc_concepts: ["climate change"],
    text: "Copernicus and greenhouse gas",
  }]);
  assert.ok(sourceRows.networkRequests <= 1, "whole-file source should be cached after phrase verification");
  await external.close();
});
