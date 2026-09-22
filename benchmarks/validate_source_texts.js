import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { StaticSearch } from "../web/src/index.js";
import { ParquetTextSource } from "../web/src/parquet_source.js";
import { startDemoServer } from "../web/demo/server.js";

const args = process.argv.slice(2);
function arg(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const dataDir = arg("--data-dir");
const sourceDir = arg("--source-dir", null);
if (!dataDir) throw new Error("--data-dir is required");
const count = Number(arg("--count", "128"));
const server = await startDemoServer({ dataDir, sourceDir });
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const index = new StaticSearch(`${origin}/data/manifest.json`);
  await index.ready();
  if (index.shards.length !== 1) throw new Error("This validation expects one shard");
  const shard = index.shards[0];
  const map = JSON.parse(gunzipSync(await readFile(`${dataDir}/sources.json.gz`)));
  const source = new ParquetTextSource(map, arg("--source-base", `${origin}/source/`), { mode: "whole" });
  const terms = await shard.bitmaps(["greenhouse", "gas"]);
  const candidates = terms.get("greenhouse").clone();
  candidates.andInPlace(terms.get("gas"));
  const ids = candidates.toArray().slice(0, count);
  candidates.dispose();
  const [bundled, external] = await Promise.all([shard.texts(ids), source.texts(ids)]);
  for (const id of ids) assert.equal(external.get(id), bundled.get(id), `text mismatch at document ${id}`);
  console.log(JSON.stringify({ validatedTexts: ids.length, sourceRequests: source.networkRequests,
    sourceBytes: source.networkBytes }));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
