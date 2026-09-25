import React, { useEffect, useMemo, useRef, useState } from "react";
import { CHART_ROW_LIMIT, numericColumns, ROW_NUMBER, suggestChartAxes } from "../src/chart_data.js";
import { AnalysisClient } from "./analysis_client.js";
import SqlBarChart from "./SqlBarChart.jsx";

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
  const building = useRef(null);
  const activeEpoch = useRef(epoch);
  const sqlRevision = useRef(0);
  const chartRevision = useRef(0);
  const [ready, setReady] = useState(null);
  const [status, setStatus] = useState("Load the complete exact result set into DuckDB when you are ready to analyse it.");
  const [result, setResult] = useState(null);
  const [xAxis, setXAxis] = useState(ROW_NUMBER);
  const [yAxis, setYAxis] = useState("");
  const [chart, setChart] = useState(null);
  const [chartFailure, setChartFailure] = useState(null);
  const [showValues, setShowValues] = useState(true);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const numeric = useMemo(() => result ? numericColumns(result.columns, result.rows) : [], [result]);

  useEffect(() => {
    activeEpoch.current = epoch;
    building.current?.close();
    building.current = null;
    const current = engine.current;
    engine.current = null;
    current?.close();
    setReady(null);
    setResult(null);
    setChart(null);
    setChartFailure(null);
    if (ready) setStatus("SQL changed · run preview to refresh the output.");
    setFailure(null);
    setBusy(false);
    setStatus("Load the complete exact result set into DuckDB when you are ready to analyse it.");
  }, [epoch]);

  useEffect(() => () => { building.current?.close(); engine.current?.close(); }, []);

  function showPreview(value, query) {
    chartRevision.current++;
    setResult({ ...value, sql: query });
    const axes = suggestChartAxes(value.columns, value.rows);
    setXAxis(axes.x);
    setYAxis(axes.y);
    setChart(null);
    setChartFailure(null);
  }

  function editSql(value) {
    sqlRevision.current++;
    chartRevision.current++;
    onSqlChange(value);
    setResult(null);
    setChart(null);
    setChartFailure(null);
  }

  async function prepare() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const requestedEpoch = epoch;
    const requestedSqlRevision = sqlRevision.current;
    let created;
    try {
      created = new AnalysisClient();
      building.current = created;
      const channel = new MessageChannel();
      const initializing = created.createFromPort(channel.port1);
      const source = prepareRows(channel.port2, (message) => {
        if (activeEpoch.current === requestedEpoch) setStatus(message);
      }).then((payload) => {
        if (activeEpoch.current === requestedEpoch) setStatus(`Loading ${payload.rowCount.toLocaleString()} rows into DuckDB-Wasm…`);
        return payload;
      });
      const [payload] = await Promise.all([source, initializing]);
      if (activeEpoch.current !== requestedEpoch) { created.close(); return; }
      building.current = null;
      await engine.current?.close();
      if (activeEpoch.current !== requestedEpoch) { await created.close(); return; }
      engine.current = created;
      setReady(payload);
      const duplicateNote = payload.duplicatesRemoved ? ` · ${payload.duplicatesRemoved.toLocaleString()} duplicate IDs removed` : "";
      setStatus(`${payload.rowCount.toLocaleString()} exact rows loaded${duplicateNote} · ${payload.networkRequests} new source requests / ${(payload.networkBytes / 1e6).toFixed(2)} MB · data stays in this tab`);
      const value = await engine.current.preview(sql);
      if (activeEpoch.current === requestedEpoch && sqlRevision.current === requestedSqlRevision) showPreview(value, sql);
    } catch (error) {
      created?.close();
      if (activeEpoch.current !== requestedEpoch) return;
      building.current = null;
      setFailure(error.message || "Could not prepare the analysis database.");
      setStatus("Analysis unavailable");
    } finally {
      if (activeEpoch.current === requestedEpoch) setBusy(false);
    }
  }

  async function runSql() {
    if (!engine.current || busy) return;
    setBusy(true);
    setFailure(null);
    setStatus("Running SQL in DuckDB-Wasm…");
    const requestedEpoch = epoch;
    const requestedSqlRevision = sqlRevision.current;
    try {
      const value = await engine.current.preview(sql);
      if (activeEpoch.current !== requestedEpoch || sqlRevision.current !== requestedSqlRevision) return;
      showPreview(value, sql);
      setStatus(`${value.shown.toLocaleString()} preview rows · preview capped at 200; downloads run the complete query`);
    } catch (error) {
      if (activeEpoch.current !== requestedEpoch || sqlRevision.current !== requestedSqlRevision) return;
      setFailure(error.message || "The SQL query failed.");
      setStatus("SQL query failed");
    } finally {
      if (activeEpoch.current === requestedEpoch) setBusy(false);
    }
  }

  async function createChart() {
    if (!engine.current || !result || busy) return;
    setBusy(true);
    setChartFailure(null);
    setStatus(result.complete ? "Building chart from the cached SQL preview…" : "Reading additional SQL output for the bar chart…");
    const requestedEpoch = epoch;
    const requestedChartRevision = chartRevision.current;
    try {
      const output = await engine.current.chart(result.sql, xAxis, yAxis);
      if (activeEpoch.current !== requestedEpoch || chartRevision.current !== requestedChartRevision) return;
      setChart({ ...output, x: xAxis, y: yAxis });
      setShowValues(output.bars.length <= 60);
      setStatus(`Bar chart ready · ${output.bars.length.toLocaleString()} bars${output.skipped ? ` · ${output.skipped.toLocaleString()} rows with null Y skipped` : ""}`);
    } catch (error) {
      if (activeEpoch.current !== requestedEpoch || chartRevision.current !== requestedChartRevision) return;
      setChart(null);
      setChartFailure(error.message || "Could not create the bar chart.");
      setStatus("Bar chart unavailable");
    } finally {
      if (activeEpoch.current === requestedEpoch) setBusy(false);
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

    <p id="analysis-status" className="mt-3 font-mono text-xs leading-5 text-stone-500" aria-live="polite">
      {busy && <span className="mr-2 inline-block size-3 animate-spin rounded-full border-2 border-stone-300 border-t-green-800 align-[-1px]" aria-hidden="true" />}
      {status}
    </p>
    {!ready && <p className="mt-2 text-xs leading-5 text-stone-500">If the current page contains only the first 50 hits, preparation completes an exhaustive exact search first. ID deduplication is currently <strong>{deduplicate ? "on" : "off"}</strong>. Very broad queries can use substantial transfer and browser memory.</p>}
    {failure && <div className="mt-3 border-l-2 border-red-700 bg-red-50 px-4 py-3 text-sm text-red-950" role="alert">{failure}</div>}

    {ready && <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(380px,0.85fr)_minmax(0,1.15fr)]">
      <div>
        <label htmlFor="sql" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-stone-600">SQL query</label>
        <textarea id="sql" value={sql} onChange={(event) => editSql(event.target.value)} spellCheck="false" className="h-56 w-full resize-y border border-stone-400 bg-white p-4 font-mono text-xs leading-5 outline-none focus:border-green-800 focus:ring-2 focus:ring-green-800/15" />
        <div className="mt-3 flex flex-wrap gap-2">
          <button id="run-sql" type="button" disabled={busy} onClick={runSql} className="border border-stone-950 bg-stone-950 px-4 py-2 text-xs font-semibold text-white hover:bg-green-900 disabled:opacity-50">Run</button>
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

    {ready && result && <section className="mt-6 border-t border-stone-300 pt-5" aria-labelledby="sql-chart-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <h3 id="sql-chart-title" className="text-sm font-semibold text-stone-950">Chart this SQL output</h3>
          <p className="mt-1 text-xs leading-5 text-stone-600">Each output row becomes one bar. X supplies its label; numeric Y sets its height. Use <code className="font-mono">GROUP BY</code> for totals and <code className="font-mono">ORDER BY</code> for bar order—the chart does not aggregate or sort for you.</p>
        </div>
        <span className="font-mono text-[11px] text-stone-500">Preview: {result.shown.toLocaleString()} rows · chart: up to {CHART_ROW_LIMIT.toLocaleString()}</span>
      </div>
      {numeric.length ? <div className="mt-4 flex flex-wrap items-end gap-3">
        <label htmlFor="chart-x" className="text-xs font-medium text-stone-600">X-axis · label
          <select id="chart-x" value={xAxis} onChange={(event) => { chartRevision.current++; setXAxis(event.target.value); setChart(null); setStatus("Chart axes changed · create the chart again."); }} className="mt-1 block min-w-40 border border-stone-400 bg-white px-3 py-2 text-sm text-stone-950 outline-none focus:border-green-800">
            <option value={ROW_NUMBER}>Row number</option>
            {result.columns.map((column) => <option key={column} value={column}>{column}</option>)}
          </select>
        </label>
        <label htmlFor="chart-y" className="text-xs font-medium text-stone-600">Y-axis · numeric value
          <select id="chart-y" value={yAxis} onChange={(event) => { chartRevision.current++; setYAxis(event.target.value); setChart(null); setStatus("Chart axes changed · create the chart again."); }} className="mt-1 block min-w-40 border border-stone-400 bg-white px-3 py-2 text-sm text-stone-950 outline-none focus:border-green-800">
            {!yAxis && <option value="">Choose a measure</option>}
            {numeric.map((column) => <option key={column} value={column}>{column}</option>)}
          </select>
        </label>
        <button id="create-sql-chart" type="button" disabled={busy || !yAxis} onClick={createChart} className="border border-stone-950 bg-stone-950 px-4 py-2 text-xs font-semibold text-white hover:bg-green-900 disabled:opacity-50">{busy ? "Building…" : chart ? "Update chart" : "Create bar chart"}</button>
      </div> : <p className="mt-3 text-xs leading-5 text-stone-500">A bar chart needs a numeric output column. Try <code className="font-mono">SELECT date_part('year', CAST(date AS DATE)) AS year, count(*) AS documents FROM search_results GROUP BY year ORDER BY year</code>.</p>}
      <p className="mt-3 text-xs leading-5 text-stone-500">{result.complete ? "The complete SQL output is already cached; charting it does not rerun SQL." : `The preview shows 200 rows. Charting fetches up to ${CHART_ROW_LIMIT.toLocaleString()} rows once; changing chart axes reuses them.`} For larger outputs, aggregate or limit in SQL; downloads still run the full query.</p>
      {chartFailure && <p className="mt-3 border-l-2 border-red-700 bg-red-50 px-4 py-2 text-xs text-red-950" role="alert">{chartFailure}</p>}
      {chart && <div className="mt-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-stone-600">{chart.bars.length.toLocaleString()} bars · X: <strong>{chart.x === ROW_NUMBER ? "row number" : chart.x}</strong> · Y: <strong>{chart.y}</strong>{chart.skipped ? ` · ${chart.skipped} null Y values skipped` : ""}</p>
          <label htmlFor="chart-values" className="inline-flex items-center gap-2 text-xs text-stone-600"><input id="chart-values" type="checkbox" checked={showValues} onChange={(event) => setShowValues(event.target.checked)} className="size-4 accent-green-800" />Show values on bars</label>
        </div>
        <SqlBarChart bars={chart.bars} xLabel={chart.x === ROW_NUMBER ? "Row number" : chart.x} yLabel={chart.y} showValues={showValues} />
      </div>}
    </section>}
  </section>;
}
