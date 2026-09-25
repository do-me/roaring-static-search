import assert from "node:assert/strict";
import test from "node:test";

import { decodeSql, encodeSql } from "../src/sql_url.js";

test("long SQL compresses to a URL-safe fragment and restores exactly", async () => {
  const rule = "SELECT 'é climate' AS label, regexp_matches(text, '\\bcopernicus\\b|\\batmosphere\\b', 'i') AS hit\n";
  const sql = `WITH service_rules AS (\n${rule.repeat(200)})\nSELECT * FROM service_rules;`;
  const encoded = await encodeSql(sql);
  assert.match(encoded, /^g\.[A-Za-z0-9_-]+$/);
  assert.ok(encoded.length < encodeURIComponent(sql).length / 3);
  assert.equal(await decodeSql(encoded), sql);
});

test("plain fallback also round-trips and malformed fragments fail safely", async () => {
  const saved = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  try {
    const encoded = await encodeSql("SELECT 'é';");
    assert.match(encoded, /^u\.[A-Za-z0-9_-]+$/);
    assert.equal(await decodeSql(encoded), "SELECT 'é';");
  } finally {
    globalThis.CompressionStream = saved;
  }
  await assert.rejects(() => decodeSql("g.not-base64!"), /unknown format/);
});
