import React, { useEffect, useRef, useState } from "react";

export const DEFAULT_SQL = `SELECT
  date_part('year', CAST(date AS DATE)) AS year,
  count(*) AS documents
FROM search_results
GROUP BY year
ORDER BY year;`;

function display(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(" · ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function download({ bytes, filename, mime }) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AnalysisPanel({ epoch, prepareRows, deduplicate, sql, onSqlChange }) {
  const engine = useRef(null);
  const activeEpoch = useRef(epoch);
  const [ready, setReady] = useState(null);
  const [status, setStatus] = useState("Load the complete exact result set into DuckDB when you are ready to analyse it.");
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    activeEpoch.current = epoch;
    const current = engine.current;
    engine.current = null;
    current?.close();
    setReady(null);
    setResult(null);
    setFailure(null);
    setBusy(false);
    setStatus("Load the complete exact result set into DuckDB when you are ready to analyse it.");
  }, [epoch]);

  useEffect(() => () => { engine.current?.close(); }, []);

  async function prepare() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const requestedEpoch = epoch;
    try {
      const payload = await prepareRows(setStatus);
      if (activeEpoch.current !== requestedEpoch) return;
      setStatus(`Starting DuckDB-Wasm for ${payload.rows.length.toLocaleString()} rows…`);
      const { BrowserAnalysis } = await import("../src/duckdb_analysis.js");
      if (activeEpoch.current !== requestedEpoch) return;
      await engine.current?.close();
      const created = await BrowserAnalysis.create(payload.rows);
      if (activeEpoch.current !== requestedEpoch) { await created.close(); return; }
      engine.current = created;
      setReady(payload);
      const duplicateNote = payload.duplicatesRemoved ? ` · ${payload.duplicatesRemoved.toLocaleString()} duplicate IDs removed` : "";
      setStatus(`${payload.rows.length.toLocaleString()} exact rows loaded${duplicateNote} · ${payload.networkRequests} new source requests / ${(payload.networkBytes / 1e6).toFixed(2)} MB · data stays in this tab`);
      setResult(await engine.current.preview(sql));
    } catch (error) {
      setFailure(error.message || "Could not prepare the analysis database.");
      setStatus("Analysis unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function runSql() {
    if (!engine.current || busy) return;
    setBusy(true);
    setFailure(null);
    setStatus("Running SQL in DuckDB-Wasm…");
    try {
      const value = await engine.current.preview(sql);
      setResult(value);
      setStatus(`${value.shown.toLocaleString()} preview rows · preview capped at 200; downloads run the complete query`);
    } catch (error) {
      setFailure(error.message || "The SQL query failed.");
      setStatus("SQL query failed");
    } finally {
      setBusy(false);
    }
  }

  async function exportResult(format) {
    if (!engine.current || busy) return;
    setBusy(true);
    setFailure(null);
    setStatus(format === "xlsx" ? "Building Excel file (the Excel extension may load once)…" : `Building ${format.toUpperCase()} file…`);
    try {
      const output = await engine.current.export(sql, format);
      download(output);
      setStatus(`${output.filename} · ${(output.bytes.byteLength / 1e6).toFixed(2)} MB downloaded`);
    } catch (error) {
      setFailure(error.message || `Could not export ${format.toUpperCase()}.`);
      setStatus("Export failed");
    } finally {
      setBusy(false);
    }
  }

  return <section className="mt-10 border-t border-stone-300 pt-6" aria-labelledby="analysis-title">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl">
        <h2 id="analysis-title" className="text-lg font-semibold tracking-tight">Analyse exact results with SQL</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">Creates a private <code className="font-mono text-xs text-stone-900">search_results</code> table with the complete exact result set and all 14 source columns. The index, cached Parquet data, SQL engine, and exports remain in your browser.</p>
      </div>
      {!ready && <button id="prepare-analysis" type="button" disabled={busy} onClick={prepare} className="border border-stone-950 bg-stone-950 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-900 disabled:cursor-wait disabled:opacity-50">{busy ? "Preparing…" : "Prepare full analysis"}</button>}
    </div>

    <p id="analysis-status" className="mt-3 font-mono text-xs leading-5 text-stone-500" aria-live="polite">{status}</p>
    {!ready && <p className="mt-2 text-xs leading-5 text-stone-500">If the current page contains only the first 50 hits, preparation completes an exhaustive exact search first. ID deduplication is currently <strong>{deduplicate ? "on" : "off"}</strong>. Very broad queries can use substantial transfer and browser memory.</p>}
    {failure && <div className="mt-3 border-l-2 border-red-700 bg-red-50 px-4 py-3 text-sm text-red-950" role="alert">{failure}</div>}

    {ready && <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(380px,0.85fr)_minmax(0,1.15fr)]">
      <div>
        <label htmlFor="sql" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-stone-600">SQL query</label>
        <textarea id="sql" value={sql} onChange={(event) => onSqlChange(event.target.value)} spellCheck="false" className="h-56 w-full resize-y border border-stone-400 bg-white p-4 font-mono text-xs leading-5 outline-none focus:border-green-800 focus:ring-2 focus:ring-green-800/15" />
        <div className="mt-3 flex flex-wrap gap-2">
          <button id="run-sql" type="button" disabled={busy} onClick={runSql} className="border border-stone-950 bg-stone-950 px-4 py-2 text-xs font-semibold text-white hover:bg-green-900 disabled:opacity-50">Run preview</button>
          {[["parquet", "Parquet"], ["csv", "CSV"], ["xlsx", "Excel"]].map(([format, label]) => <button key={format} type="button" disabled={busy} onClick={() => exportResult(format)} className="border border-stone-400 bg-white px-4 py-2 text-xs font-semibold hover:border-green-800 hover:text-green-800 disabled:opacity-50">Download {label}</button>)}
        </div>
        <p className="mt-3 text-xs leading-5 text-stone-500">Use a read-only query beginning with <code className="font-mono">SELECT</code>, <code className="font-mono">WITH</code>, <code className="font-mono">FROM</code>, <code className="font-mono">TABLE</code>, or <code className="font-mono">VALUES</code>. Downloads evaluate the full query, not the 200-row preview.</p>
      </div>

      <div className="min-w-0">
        <div className="mb-2 flex items-baseline justify-between gap-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-600">Query preview</h3>
          {result && <span className="font-mono text-[11px] text-stone-500">{result.shown.toLocaleString()} rows · {result.columns.length} columns</span>}
        </div>
        <div className="h-72 overflow-auto border border-stone-300 bg-white">
          {result?.columns.length ? <table className="w-max min-w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-stone-100 text-stone-700"><tr>{result.columns.map((column) => <th key={column} className="border-b border-r border-stone-300 px-3 py-2 font-semibold">{column}</th>)}</tr></thead>
            <tbody>{result.rows.map((row, index) => <tr key={index} className="odd:bg-white even:bg-stone-50">{result.columns.map((column) => <td key={column} className="max-w-80 truncate border-b border-r border-stone-200 px-3 py-2 font-mono" title={display(row[column])}>{display(row[column])}</td>)}</tr>)}</tbody>
          </table> : <p className="p-5 text-sm text-stone-400">Run a query to see a preview.</p>}
        </div>
      </div>
    </div>}
  </section>;
}
