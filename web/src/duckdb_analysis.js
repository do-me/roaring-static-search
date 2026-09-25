import * as duckdb from "@duckdb/duckdb-wasm";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import { CHART_ROW_LIMIT } from "./chart_data.js";
import { excelSafeQuery, normalizeXlsxBytes } from "./excel_export.js";

const BUNDLES = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

const EXPORTS = {
  csv: { extension: "csv", mime: "text/csv;charset=utf-8", copy: "FORMAT CSV, HEADER true" },
  parquet: { extension: "parquet", mime: "application/vnd.apache.parquet", copy: "FORMAT PARQUET" },
  xlsx: { extension: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", copy: "FORMAT XLSX, HEADER true" },
};

function queryExpression(sql) {
  const value = String(sql || "").trim().replace(/;+\s*$/, "");
  if (!value) throw new Error("Enter a SQL query first.");
  if (!/^(select|with|from|table|values)\b/i.test(value.replace(/^\s*(?:--[^\n]*\n\s*)*/, ""))) {
    throw new Error("Use a SELECT, WITH, FROM, TABLE, or VALUES query. The analysis database is read-only from this page.");
  }
  return value;
}

function jsValue(value) {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (Array.isArray(value)) return value.map(jsValue);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    if (typeof value.toJSON === "function") return jsValue(value.toJSON());
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsValue(item)]));
  }
  return value;
}

/** A disposable, in-browser DuckDB database containing only exact search results. */
export class BrowserAnalysis {
  static async create(rows) {
    if (!Array.isArray(rows) || !rows.length) throw new Error("There are no exact rows to analyse.");
    const bundle = await duckdb.selectBundle(BUNDLES);
    const worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    try {
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      const connection = await db.connect();
      await db.registerFileText("search-results.json", JSON.stringify(rows));
      await connection.insertJSONFromPath("search-results.json", { name: "search_results", create: true });
      await db.dropFile("search-results.json");
      return new BrowserAnalysis(db, connection, worker, rows.length);
    } catch (error) {
      await db.terminate().catch(() => {});
      worker.terminate();
      throw error;
    }
  }

  constructor(db, connection, worker, rowCount) {
    this.db = db;
    this.connection = connection;
    this.worker = worker;
    this.rowCount = rowCount;
    this.closed = false;
    this.previewCache = null;
  }

  async preview(sql, limit = 200) {
    const expression = queryExpression(sql);
    if (this.previewCache?.expression === expression) {
      const { columns, rows } = this.previewCache;
      return { columns, rows: rows.slice(0, limit), shown: Math.min(rows.length, limit), complete: rows.length <= limit };
    }
    const table = await this.connection.query(`SELECT * FROM (${expression}) AS __preview LIMIT ${Number(limit) + 1}`);
    const columns = table.schema.fields.map((field) => field.name);
    const complete = table.numRows <= limit;
    const rows = table.toArray().slice(0, limit).map((row) => jsValue(row));
    this.previewCache = complete ? { expression, columns, rows } : null;
    return { columns, rows, shown: rows.length, complete };
  }

  async chartRows(sql) {
    const expression = queryExpression(sql);
    if (this.previewCache?.expression === expression) return this.previewCache;
    const table = await this.connection.query(`SELECT * FROM (${expression}) AS __chart LIMIT ${CHART_ROW_LIMIT + 1}`);
    if (table.numRows > CHART_ROW_LIMIT) {
      throw new Error(`The SQL output has more than ${CHART_ROW_LIMIT} rows. Add GROUP BY, a filter, or LIMIT before making a bar chart; downloads still use the full query.`);
    }
    const output = {
      columns: table.schema.fields.map((field) => field.name),
      rows: table.toArray().map((row) => jsValue(row)),
    };
    this.previewCache = { expression, ...output };
    return output;
  }

  async export(sql, format) {
    const settings = EXPORTS[format];
    if (!settings) throw new Error(`Unsupported export format: ${format}`);
    const expression = queryExpression(sql);
    const filename = `eur-lex-search-${Date.now()}.${settings.extension}`;
    let exportExpression = expression;
    if (format === "xlsx") {
      await this.connection.query("INSTALL excel; LOAD excel;");
      const schema = await this.connection.query(`DESCRIBE SELECT * FROM (${expression}) AS __excel_source`);
      exportExpression = excelSafeQuery(expression, schema.toArray().map((row) => ({
        column_name: row.column_name,
        column_type: row.column_type,
      })));
    }
    await this.db.dropFile(filename).catch(() => {});
    try {
      await this.connection.query(`COPY (${exportExpression}) TO '${filename}' (${settings.copy})`);
      await this.db.flushFiles();
      // copyFileToBuffer may expose storage owned by DuckDB's virtual filesystem.
      // Keep an independent copy before the temporary file is removed.
      const copied = Uint8Array.from(await this.db.copyFileToBuffer(filename));
      // duckdb/duckdb-wasm#2119: the stray leading byte is not always the same.
      const bytes = format === "xlsx" ? normalizeXlsxBytes(copied) : copied;
      return { filename, mime: settings.mime, bytes };
    } finally {
      await this.db.dropFile(filename).catch(() => {});
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.connection.close().catch(() => {});
    await this.db.terminate().catch(() => {});
    this.worker.terminate();
  }
}
