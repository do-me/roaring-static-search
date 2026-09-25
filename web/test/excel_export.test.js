import assert from "node:assert/strict";
import test from "node:test";

import { excelSafeQuery, normalizeXlsxBytes } from "../src/excel_export.js";

const zipStart = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

test("accepts an unmodified XLSX ZIP header", () => {
  assert.equal(normalizeXlsxBytes(zipStart), zipStart);
});

test("removes one stray byte regardless of its value", () => {
  for (const stray of [0x78, 0x38, 0x00, 0xff]) {
    const result = normalizeXlsxBytes(Uint8Array.from([stray, ...zipStart]));
    assert.deepEqual(result, zipStart);
  }
});

test("rejects files without a ZIP header at byte zero or one", () => {
  assert.throws(() => normalizeXlsxBytes(Uint8Array.from([0x38, 0x78, ...zipStart])), /invalid Excel workbook/);
  assert.throws(() => normalizeXlsxBytes(Uint8Array.from([0x38, 0x50, 0x4b, 0x00, 0x00])), /invalid Excel workbook/);
});

test("Excel query substitutes over-limit text without changing numeric columns", () => {
  const expression = "SELECT 1 AS year, 'text' AS \"odd\"\"name\"";
  const wrapped = excelSafeQuery(expression, [
    { column_name: "year", column_type: "INTEGER" },
    { column_name: 'odd"name', column_type: "VARCHAR" },
  ]);
  assert.match(wrapped, /SELECT \* REPLACE/);
  assert.match(wrapped, /length\(CAST\("odd""name" AS VARCHAR\)\) > 32767/);
  assert.match(wrapped, /THEN 'exceeding Excel limits'/);
  assert.doesNotMatch(wrapped, /AS "year"/);
  assert.equal(excelSafeQuery(expression, [{ column_name: "year", column_type: "INTEGER" }]), expression);
});
