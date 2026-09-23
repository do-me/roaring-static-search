import * as duckdb from "@duckdb/duckdb-wasm";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";

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
  }

  async preview(sql, limit = 200) {
    const expression = queryExpression(sql);
    const table = await this.connection.query(`SELECT * FROM (${expression}) AS __preview LIMIT ${Number(limit)}`);
    const columns = table.schema.fields.map((field) => field.name);
    const rows = table.toArray().map((row) => jsValue(row));
    return { columns, rows, shown: rows.length };
  }

  async export(sql, format) {
    const settings = EXPORTS[format];
    if (!settings) throw new Error(`Unsupported export format: ${format}`);
    const expression = queryExpression(sql);
    const filename = `eur-lex-search-${Date.now()}.${settings.extension}`;
    if (format === "xlsx") {
      await this.connection.query("INSTALL excel; LOAD excel;");
    }
    await this.db.dropFile(filename).catch(() => {});
    try {
      await this.connection.query(`COPY (${expression}) TO '${filename}' (${settings.copy})`);
      return { filename, mime: settings.mime, bytes: await this.db.copyFileToBuffer(filename) };
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
