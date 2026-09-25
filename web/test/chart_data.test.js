import assert from "node:assert/strict";
import test from "node:test";

import { barsFromRows, numericColumns, numericValue, ROW_NUMBER, suggestChartAxes } from "../src/chart_data.js";

test("SQL chart suggests year and count, while accepting decimal measures", () => {
  const rows = [{ year: 2024, documents: 3, share: "0.25" }, { year: 2025, documents: 7, share: "-1.5" }];
  assert.deepEqual(numericColumns(["year", "documents", "share"], rows), ["year", "documents", "share"]);
  assert.deepEqual(suggestChartAxes(["year", "documents", "share"], rows), { x: "year", y: "documents" });
  assert.equal(numericValue("1e3"), 1000);
  assert.equal(numericValue("2025-01-15"), null);
  assert.deepEqual(barsFromRows(rows, "year", "share"), {
    bars: [{ label: "2024", value: 0.25 }, { label: "2025", value: -1.5 }], skipped: 0,
  });
});

test("SQL chart treats null measures as skipped rows and can label by row number", () => {
  const rows = [{ total: 3 }, { total: null }, { total: 5 }];
  assert.deepEqual(suggestChartAxes(["total"], rows), { x: ROW_NUMBER, y: "total" });
  assert.deepEqual(barsFromRows(rows, ROW_NUMBER, "total"), {
    bars: [{ label: "1", value: 3 }, { label: "3", value: 5 }], skipped: 1,
  });
});

test("SQL chart rejects non-numeric measures rather than silently plotting wrong values", () => {
  assert.deepEqual(numericColumns(["label", "value"], [{ label: "A", value: "not a number" }]), []);
  assert.throws(() => barsFromRows([{ label: "A", value: "abc" }], "label", "value"), /non-numeric value at row 1/);
  assert.throws(() => barsFromRows([{ label: "A", value: null }], "label", "value"), /no numeric values/);
});
