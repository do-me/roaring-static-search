import assert from "node:assert/strict";
import test from "node:test";

import { barsFromRows, numericColumns, numericValue, ROW_NUMBER, stackedBarsFromRows, suggestChartAxes, suggestSeriesColumn } from "../src/chart_data.js";

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

test("year remains the default label when the measure has a custom name", () => {
  const rows = [{ year: 2024, methane_hits: 3 }, { year: 2025, methane_hits: 7 }];
  assert.deepEqual(suggestChartAxes(["year", "methane_hits"], rows), { x: "year", y: "methane_hits" });
  assert.deepEqual(suggestChartAxes(["year"], [{ year: 2024 }]), { x: "year", y: "" });
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

test("stacked chart groups years and document types, summing repeated pairs", () => {
  const rows = [
    { year: 2020, document_type: "decision", document_count: 2 },
    { year: 2020, document_type: "regulation", document_count: 3 },
    { year: 2020, document_type: "decision", document_count: 1 },
    { year: 2021, document_type: "decision", document_count: 4 },
    { year: 2021, document_type: "regulation", document_count: null },
  ];
  assert.deepEqual(suggestChartAxes(["year", "document_type", "document_count"], rows), { x: "year", y: "document_count" });
  assert.equal(suggestSeriesColumn(["year", "document_type", "document_count"], rows, "year", "document_count"), "document_type");
  assert.deepEqual(stackedBarsFromRows(rows, "year", "document_count", "document_type"), {
    bars: [
      { label: "2020", segments: [{ series: "decision", value: 3 }, { series: "regulation", value: 3 }], total: 6, positive: 6, negative: 0 },
      { label: "2021", segments: [{ series: "decision", value: 4 }], total: 4, positive: 4, negative: 0 },
    ],
    series: ["decision", "regulation"],
    skipped: 1,
  });
});

test("stacked chart separates positive and negative stacks and validates axes", () => {
  const output = stackedBarsFromRows([
    { year: 2020, type: "up", value: 3 },
    { year: 2020, type: "down", value: -2 },
  ], "year", "value", "type");
  assert.deepEqual(output.bars[0], {
    label: "2020", segments: [{ series: "up", value: 3 }, { series: "down", value: -2 }],
    total: 1, positive: 3, negative: -2,
  });
  assert.throws(() => stackedBarsFromRows([{ year: 2020, value: 1 }], "year", "value", "year"), /different columns/);
});
