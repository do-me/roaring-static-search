function zipHeaderAt(bytes, offset) {
  return bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b
    && bytes[offset + 2] === 0x03 && bytes[offset + 3] === 0x04;
}

export const EXCEL_CELL_LIMIT = 32767;
export const EXCEL_LIMIT_PLACEHOLDER = "exceeding Excel limits";

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

/** Keep the XLSX cell limit from silently truncating long text. */
export function excelSafeQuery(expression, fields) {
  const replacements = fields
    .filter(({ column_type: type }) => /^(?:VARCHAR|JSON|ENUM|STRUCT|MAP|UNION|LIST)|\[\]$/i.test(String(type)))
    .map(({ column_name: name }) => {
      const column = quoteIdentifier(name);
      return `CASE WHEN length(CAST(${column} AS VARCHAR)) > ${EXCEL_CELL_LIMIT} THEN '${EXCEL_LIMIT_PLACEHOLDER}' ELSE CAST(${column} AS VARCHAR) END AS ${column}`;
    });
  if (!replacements.length) return expression;
  return `SELECT * REPLACE (${replacements.join(", ")}) FROM (${expression}) AS __excel_safe`;
}

/** DuckDB-Wasm may prepend one arbitrary stray byte to an XLSX ZIP file. */
export function normalizeXlsxBytes(bytes) {
  if (zipHeaderAt(bytes, 0)) return bytes;
  if (zipHeaderAt(bytes, 1)) return bytes.slice(1);
  const magic = [...bytes.subarray(0, 8)].map((value) => value.toString(16).padStart(2, "0")).join(" ") || "empty";
  throw new Error(`DuckDB produced an invalid Excel workbook (${bytes.byteLength} bytes; magic ${magic}).`);
}
