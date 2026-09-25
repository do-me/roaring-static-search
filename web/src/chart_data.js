export const CHART_ROW_LIMIT = 500;
export const ROW_NUMBER = "__row_number__";

export function numericValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function numericColumns(columns, rows) {
  return columns.filter((column) => rows.some((row) => numericValue(row[column]) !== null)
    && rows.every((row) => row[column] == null || numericValue(row[column]) !== null));
}

export function suggestChartAxes(columns, rows) {
  const numeric = numericColumns(columns, rows);
  if (!numeric.length) return { x: ROW_NUMBER, y: "" };
  const year = columns.find((column) => /^(?:year|.*_year)$/i.test(column));
  const measures = year ? numeric.filter((column) => column !== year) : numeric;
  const y = measures.find((column) => /^(documents|count|total|frequency|n|value)$/i.test(column)) || measures[0] || "";
  const remaining = columns.filter((column) => column !== y);
  const x = year || remaining.find((column) => /^(date|month|category|label|name)$/i.test(column))
    || remaining.find((column) => !numeric.includes(column))
    || remaining[0] || ROW_NUMBER;
  return { x, y };
}

function label(value) {
  if (value == null || value === "") return "(empty)";
  if (Array.isArray(value)) return value.join(" · ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function barsFromRows(rows, xColumn, yColumn) {
  if (!yColumn) throw new Error("Choose a numeric Y-axis column.");
  const bars = [];
  let skipped = 0;
  for (const [index, row] of rows.entries()) {
    if (row[yColumn] == null) { skipped++; continue; }
    const value = numericValue(row[yColumn]);
    if (value === null) throw new Error(`Y-axis column “${yColumn}” contains a non-numeric value at row ${index + 1}.`);
    bars.push({ label: xColumn === ROW_NUMBER ? String(index + 1) : label(row[xColumn]), value });
  }
  if (!bars.length) throw new Error(`Y-axis column “${yColumn}” has no numeric values to chart.`);
  return { bars, skipped };
}
