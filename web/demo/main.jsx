import React, { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import HighTable from "hightable";
import "hightable/src/HighTable.css";
import "./style.css";

import { StaticSearch } from "../src/index.js";
import AnalysisPanel, { DEFAULT_SQL } from "./AnalysisPanel.jsx";

const COLUMNS = [
  "url", "celex", "eli", "title", "date", "lang", "institutions",
  "work_types", "procedure_ids", "directory_codes", "formats",
  "eurovoc_concepts", "eurovoc_concepts_ids", "text",
];
const COLUMN_CONFIGURATION = {
  url: { minWidth: 260 }, celex: { minWidth: 150 }, eli: { minWidth: 260 },
  title: { minWidth: 420 }, date: { minWidth: 115 }, lang: { minWidth: 80 },
  institutions: { minWidth: 220 }, work_types: { minWidth: 180 },
  procedure_ids: { minWidth: 180 }, directory_codes: { minWidth: 180 },
  formats: { minWidth: 180 }, eurovoc_concepts: { minWidth: 360 },
  eurovoc_concepts_ids: { minWidth: 260 }, text: { minWidth: 560 },
};
const THIS_YEAR = new Date().getFullYear();
const DEFAULT_QUERY = 'copernicus AND (climate OR "greenhouse gas")';
const DEFAULT_YEAR_FROM = 2015;

const params = new URLSearchParams(location.search);
function integerParam(name, fallback) {
  if (!params.has(name)) return fallback;
  const raw = params.get(name);
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) ? value : fallback;
}

function booleanParam(name, fallback) {
  if (!params.has(name)) return fallback;
  return !["0", "false", "off"].includes(params.get(name).toLowerCase());
}

const manifestUrl = params.get("manifest") || import.meta.env.VITE_SEARCH_MANIFEST_URL || "/data/manifest.json";
const includeMetadata = params.has("titles") ? params.get("titles") === "1" : import.meta.env.VITE_SEARCH_SHOW_TITLES === "true";
const verificationBatchSize = Number(params.get("verifyBatch") || import.meta.env.VITE_SEARCH_VERIFICATION_BATCH_SIZE || "64");
const sourceMap = params.get("sourceMap");
const textSources = sourceMap ? {
  [params.get("sourceShard") || "archive"]: {
    mapUrl: sourceMap, baseUrl: params.get("sourceBase"),
    mode: params.get("sourceMode") || "whole",
    concurrency: Number(params.get("sourceConcurrency") || "8"),
  },
} : {};
const search = new StaticSearch(new URL(manifestUrl, location.href), { textSources });

function stringify(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(" · ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function uniqueById(hits) {
  const seen = new Set();
  return hits.filter((hit) => {
    const id = typeof hit.id === "string" ? hit.id.trim() : hit.id;
    if (id == null || id === "") return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

class SearchResultsDataFrame {
  constructor(hits, onHydration) {
    this.hits = [...hits];
    this.onHydration = onHydration;
    this.columnDescriptors = COLUMNS.map((name) => ({ name }));
    this.eventTarget = new EventTarget();
    this.cache = new Map();
    this.queue = Promise.resolve();
    this.networkRequests = 0;
    this.networkBytes = 0;
  }

  get numRows() { return this.hits.length; }

  append(hits) {
    this.hits.push(...hits);
    this.eventTarget.dispatchEvent(new Event("numrowschange"));
    this.eventTarget.dispatchEvent(new Event("resolve"));
  }

  getRowNumber({ row }) { return row >= 0 && row < this.hits.length ? { value: row } : undefined; }

  getCell({ row, column }) {
    if (column === "celex" && this.hits[row]) return { value: this.hits[row].id };
    const values = this.cache.get(row);
    if (values?.has(column)) return { value: values.get(column) };
    const hit = this.hits[row];
    return hit && Object.hasOwn(hit, column) ? { value: hit[column] } : undefined;
  }

  fetch({ rowStart, rowEnd, columns = [], signal }) {
    const task = this.queue.catch(() => {}).then(() => this.fetchNow({ rowStart, rowEnd, columns, signal }));
    this.queue = task;
    return task;
  }

  async fetchNow({ rowStart, rowEnd, columns, signal }) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const selectedColumns = [...new Set(columns.filter((column) => COLUMNS.includes(column) && column !== "celex"))];
    const selectedRows = [];
    for (let row = Math.max(0, rowStart); row < Math.min(rowEnd, this.hits.length); row++) {
      if (selectedColumns.some((column) => !this.cache.get(row)?.has(column))) selectedRows.push(row);
    }
    if (!selectedRows.length || !selectedColumns.length) return;
    const answer = await search.getSourceRows(selectedRows.map((row) => this.hits[row]), { columns: selectedColumns });
    selectedRows.forEach((row, index) => {
      if (!this.cache.has(row)) this.cache.set(row, new Map());
      for (const column of selectedColumns) this.cache.get(row).set(column, answer.rows[index]?.[column] ?? null);
    });
    this.networkRequests += answer.networkRequests;
    this.networkBytes += answer.networkBytes;
    this.onHydration?.({ loaded: true, requests: this.networkRequests, bytes: this.networkBytes });
    this.eventTarget.dispatchEvent(new Event("resolve"));
  }
}

function Timeline({ hits }) {
  const counts = useMemo(() => {
    const values = new Map();
    for (const hit of hits) if (Number.isInteger(hit.year)) values.set(hit.year, (values.get(hit.year) || 0) + 1);
    return [...values].sort(([a], [b]) => a - b);
  }, [hits]);
  if (!counts.length) return null;
  const width = Math.max(720, counts.length * 45);
  const height = 250;
  const pad = { left: 54, right: 18, top: 18, bottom: 44 };
  const chartHeight = height - pad.top - pad.bottom;
  const chartWidth = width - pad.left - pad.right;
  const maximum = Math.max(...counts.map(([, count]) => count));
  const gap = Math.min(10, chartWidth / counts.length * 0.22);
  const barWidth = chartWidth / counts.length - gap;
  const ticks = [0, Math.ceil(maximum / 2), maximum].filter((value, index, all) => all.indexOf(value) === index);
  const labelEvery = counts.length > 28 ? 5 : counts.length > 16 ? 2 : 1;
  return <section className="border-y border-stone-300 py-5" aria-labelledby="timeline-title">
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h2 id="timeline-title" className="text-sm font-semibold text-stone-950">Matches by year</h2>
        <p className="mt-1 text-xs text-stone-500">Counts reflect the result set shown below.</p>
      </div>
      <span className="font-mono text-xs tabular-nums text-stone-500">{hits.length.toLocaleString()} documents</span>
    </div>
    <div className="overflow-x-auto" role="img" aria-label={`Bar chart of document counts for ${counts.length} years`}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-64 min-w-[720px] w-full" aria-hidden="true">
        {ticks.map((tick) => {
          const y = pad.top + chartHeight - (tick / maximum) * chartHeight;
          return <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="#d6d3d1" strokeWidth="1" />
            <text x={pad.left - 9} y={y + 4} textAnchor="end" fill="#78716c" fontSize="11">{tick}</text>
          </g>;
        })}
        {counts.map(([year, count], index) => {
          const x = pad.left + index * (chartWidth / counts.length) + gap / 2;
          const barHeight = (count / maximum) * chartHeight;
          const showLabel = index % labelEvery === 0 || index === counts.length - 1;
          return <g key={year}>
            <rect x={x} y={pad.top + chartHeight - barHeight} width={barWidth} height={barHeight} fill="#166534">
              <title>{year}: {count.toLocaleString()} documents</title>
            </rect>
            {showLabel && <text x={x + barWidth / 2} y={height - 17} textAnchor="middle" fill="#57534e" fontSize="11">{year}</text>}
          </g>;
        })}
      </svg>
    </div>
  </section>;
}

function Toggle({ id, checked, onChange, disabled = false, children }) {
  return <label htmlFor={id} className={`inline-flex items-center gap-2 text-sm ${disabled ? "text-stone-400" : "text-stone-700"}`}>
    <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-green-800" />
    {children}
  </label>;
}

const THEME_OPTIONS = ["light", "dark", "auto"];

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("eur-lex-theme");
      return THEME_OPTIONS.includes(saved) ? saved : "auto";
    } catch { return "auto"; }
  });
  React.useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "auto" && media.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    if (theme === "auto") media.addEventListener("change", apply);
    try { localStorage.setItem("eur-lex-theme", theme); } catch {}
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme];
}

function ThemeControl({ value, onChange }) {
  return <div className="theme-switch inline-flex border border-stone-300 bg-stone-50 p-0.5" role="group" aria-label="Colour theme">
    {THEME_OPTIONS.map((theme) => <button key={theme} type="button" aria-pressed={value === theme} onClick={() => onChange(theme)} className="px-2.5 py-1 text-[11px] font-medium capitalize text-stone-600 transition hover:text-stone-950">{theme}</button>)}
  </div>;
}

function App() {
  const [theme, setTheme] = useTheme();
  const [query, setQuery] = useState(() => params.get("q") ?? DEFAULT_QUERY);
  const [yearFrom, setYearFrom] = useState(() => integerParam("from", DEFAULT_YEAR_FROM));
  const [yearTo, setYearTo] = useState(() => integerParam("to", THIS_YEAR));
  const [bounds, setBounds] = useState({ min: 1973, max: THIS_YEAR });
  const [searchAll, setSearchAll] = useState(() => booleanParam("all", false));
  const [deduplicate, setDeduplicate] = useState(() => booleanParam("dedupe", true));
  const [sql, setSql] = useState(() => params.get("sql") ?? DEFAULT_SQL);
  const [status, setStatus] = useState("Loading index manifest…");
  const [failure, setFailure] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hydration, setHydration] = useState({ loaded: false, requests: 0, bytes: 0 });
  const [detail, setDetail] = useState(null);
  const [rawHits, setRawHits] = useState([]);
  const [lastWasAll, setLastWasAll] = useState(false);
  const [analysisEpoch, setAnalysisEpoch] = useState(0);
  const generation = useRef(0);
  const activeSearch = useRef(null);
  const [data, setData] = useState(() => new SearchResultsDataFrame([], null));

  const displayHits = useMemo(() => lastWasAll && deduplicate ? uniqueById(rawHits) : rawHits, [deduplicate, lastWasAll, rawHits]);

  const newFrame = useCallback((hits) => {
    const current = ++generation.current;
    setHydration({ loaded: false, requests: 0, bytes: 0 });
    const frame = new SearchResultsDataFrame(hits, (value) => {
      if (generation.current === current) setHydration(value);
    });
    setData(frame);
    return frame;
  }, []);

  React.useEffect(() => { newFrame(displayHits); }, [displayHits, newFrame]);

  React.useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("q", query);
    url.searchParams.set("from", String(yearFrom));
    url.searchParams.set("to", String(yearTo));
    url.searchParams.set("all", searchAll ? "1" : "0");
    url.searchParams.set("dedupe", deduplicate ? "1" : "0");
    if (sql === DEFAULT_SQL) url.searchParams.delete("sql");
    else url.searchParams.set("sql", sql);
    history.replaceState(history.state, "", url);
  }, [deduplicate, query, searchAll, sql, yearFrom, yearTo]);

  const signature = `${query.trim()}\u0000${yearFrom}\u0000${yearTo}\u0000${searchAll}`;
  const run = useCallback(async (append = false) => {
    const request = append ? activeSearch.current : { query: query.trim(), yearFrom, yearTo, searchAll };
    if (!request?.query || busy) return;
    if (!Number.isInteger(request.yearFrom) || !Number.isInteger(request.yearTo) || request.yearFrom > request.yearTo) {
      setFailure({ message: "The start year must be earlier than or equal to the end year.", retryable: false });
      return;
    }
    if (!append) activeSearch.current = request;
    if (!append) setAnalysisEpoch((value) => value + 1);
    setBusy(true);
    setFailure(null);
    setDetail(null);
    setStatus(request.searchAll ? "Finding every exact match…" : "Searching…");
    try {
      const answer = await search.search(request.query, {
        limit: request.searchAll ? null : 50,
        cursor: append ? cursor : null,
        exhaustive: request.searchAll,
        includeMetadata,
        verificationBatchSize,
        yearFrom: request.yearFrom,
        yearTo: request.yearTo,
        onProgress: (progress) => {
          if (!progress.requiresPhraseVerification) return;
          if (progress.phase === "candidates") {
            setStatus(`Exact phrase verification · ${progress.candidateCount.toLocaleString()} bitmap candidates…`);
          } else {
            setStatus(`Verifying exact phrases · ${progress.processedCandidates.toLocaleString()} / ${progress.candidateCount.toLocaleString()} candidates · ${progress.hits.toLocaleString()} matches`);
          }
        },
      });
      const combined = append ? [...rawHits, ...answer.hits] : answer.hits;
      setRawHits(combined);
      setLastWasAll(request.searchAll);
      setCursor(request.searchAll ? null : answer.nextCursor);
      const shown = request.searchAll && deduplicate ? uniqueById(combined).length : combined.length;
      const duplicateNote = request.searchAll && deduplicate && shown !== combined.length ? `; ${combined.length - shown} duplicate IDs removed` : "";
      const countLabel = answer.exactCount == null
        ? `${answer.candidateCount.toLocaleString()} bitmap candidates`
        : `${answer.exactCount.toLocaleString()} exact matches`;
      setStatus(`${shown.toLocaleString()} shown · ${countLabel}${duplicateNote} · ${answer.elapsedMs.toFixed(0)} ms · ${answer.networkRequests} requests / ${(answer.networkBytes / 1e6).toFixed(2)} MB`);
    } catch (error) {
      setFailure({ message: error.message || "The search failed.", retryable: error.retryable === true });
      setStatus("Search unavailable");
    } finally {
      setBusy(false);
    }
  }, [busy, cursor, deduplicate, query, rawHits, searchAll, yearFrom, yearTo]);

  const prepareAnalysisRows = useCallback(async (report) => {
    const request = activeSearch.current;
    if (!request?.query) throw new Error("Run a search before preparing analysis.");
    let hits = rawHits;
    let searchRequests = 0;
    let searchBytes = 0;
    if (!lastWasAll) {
      report("Completing the exhaustive exact search…");
      const answer = await search.search(request.query, {
        limit: null,
        exhaustive: true,
        includeMetadata: false,
        verificationBatchSize,
        yearFrom: request.yearFrom,
        yearTo: request.yearTo,
        onProgress: (progress) => {
          if (progress.phase === "candidates") {
            report(`${progress.candidateCount.toLocaleString()} bitmap candidates selected…`);
          } else if (progress.requiresPhraseVerification) {
            report(`Verifying exact phrases · ${progress.processedCandidates.toLocaleString()} / ${progress.candidateCount.toLocaleString()} candidates · ${progress.hits.toLocaleString()} matches`);
          }
        },
      });
      hits = answer.hits;
      searchRequests = answer.networkRequests;
      searchBytes = answer.networkBytes;
    }
    const selected = deduplicate ? uniqueById(hits) : hits;
    if (!selected.length) throw new Error("The exact result set is empty.");
    report(`Fetching all 14 source columns for ${selected.length.toLocaleString()} exact rows…`);
    const source = await search.getSourceRows(selected, { columns: COLUMNS });
    const rows = source.rows.map((row, index) => ({
      _search_rank: index + 1,
      _search_year: selected[index].year ?? null,
      _search_shard: selected[index].shard,
      _search_doc_id: selected[index].docId,
      _search_external_id: selected[index].id,
      ...row,
    }));
    return {
      rows,
      sourceMatchCount: hits.length,
      duplicatesRemoved: hits.length - selected.length,
      networkRequests: searchRequests + source.networkRequests,
      networkBytes: searchBytes + source.networkBytes,
    };
  }, [deduplicate, lastWasAll, rawHits]);

  React.useEffect(() => {
    search.ready().then(async () => {
      const declared = await search.yearBounds();
      if (declared) {
        setBounds(declared);
        setYearFrom((value) => Math.max(declared.min, Math.min(value, declared.max)));
        setYearTo((value) => Math.max(declared.min, Math.min(value, declared.max)));
      }
      setStatus("Ready");
    }, (error) => {
      setFailure({ message: error.message || "The index manifest could not be loaded.", retryable: true });
      setStatus("Index unavailable");
    });
  }, []);

  const inspectCell = useCallback((columnIndex, row) => {
    const cell = data.getCell({ row, column: COLUMNS[columnIndex] });
    if (cell) setDetail({ column: COLUMNS[columnIndex], celex: data.hits[row]?.id, value: cell.value });
  }, [data]);

  const renderCellContent = useCallback(({ cell, col }) => {
    const value = stringify(cell?.value);
    if ((COLUMNS[col] === "url" || COLUMNS[col] === "eli") && value) {
      return <a href={value} target="_blank" rel="noreferrer" className="text-green-800 underline-offset-2 hover:underline">{value}</a>;
    }
    return value;
  }, []);

  const hydrationLabel = useMemo(() => hydration.loaded
    ? `Visible source rows: ${hydration.requests} requests / ${(hydration.bytes / 1e6).toFixed(2)} MB, cached in this tab.`
    : "Full columns are fetched from source Parquet only for rows in view.", [hydration]);
  const canLoadMore = cursor && !searchAll && signature === `${activeSearch.current?.query}\u0000${activeSearch.current?.yearFrom}\u0000${activeSearch.current?.yearTo}\u0000${activeSearch.current?.searchAll}`;

  return <div className="min-h-screen bg-stone-50 text-stone-900">
    <header className="border-b border-stone-300 bg-white">
      <div className="mx-auto flex max-w-[1800px] items-end justify-between gap-8 px-5 py-6 lg:px-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">EUR-LEX full-text search</h1>
        </div>
        <div className="flex items-center gap-4">
          <ThemeControl value={theme} onChange={setTheme} />
          <a className="hidden text-sm text-stone-600 underline-offset-4 hover:text-stone-950 hover:underline sm:block" href="https://huggingface.co/datasets/do-me/EUR-LEX">View dataset ↗</a>
        </div>
      </div>
    </header>

    <main className="mx-auto max-w-[1800px] px-5 py-7 lg:px-10">
      <p className="max-w-4xl text-sm leading-6 text-stone-600">Use exact terms, <code className="border-b border-stone-400 font-mono text-xs text-stone-900">AND</code>, <code className="border-b border-stone-400 font-mono text-xs text-stone-900">OR</code>, parentheses, and quoted phrases such as <code className="border-b border-stone-400 font-mono text-xs text-stone-900">&quot;gender-based violence&quot;</code>. Quotes are required for hyphenated or multi-word phrases. The selected years determine which index shards and document ranges are read.</p>

      <form id="search-form" className="mt-6" onSubmit={(event) => { event.preventDefault(); run(false); }}>
        <label htmlFor="query" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-stone-600">Boolean query</label>
        <div className="flex flex-col gap-2 md:flex-row">
          <input id="query" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search query" spellCheck="false" className="min-w-0 flex-1 border border-stone-400 bg-white px-4 py-3 font-mono text-sm outline-none transition focus:border-green-800 focus:ring-2 focus:ring-green-800/15" />
          <button type="submit" disabled={busy} className="border border-stone-950 bg-stone-950 px-7 py-3 text-sm font-semibold text-white transition hover:bg-green-900 disabled:cursor-wait disabled:opacity-50">{busy ? "Searching…" : "Search"}</button>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-4 border-b border-stone-300 pb-5">
          <label htmlFor="year-from" className="text-xs font-medium text-stone-600">From
            <input id="year-from" type="number" min={bounds.min} max={bounds.max} value={yearFrom} onChange={(event) => setYearFrom(Number(event.target.value))} className="ml-2 w-24 border-b border-stone-400 bg-transparent px-1 py-1 font-mono text-sm text-stone-950 outline-none focus:border-green-800" />
          </label>
          <label htmlFor="year-to" className="text-xs font-medium text-stone-600">To
            <input id="year-to" type="number" min={bounds.min} max={bounds.max} value={yearTo} onChange={(event) => setYearTo(Number(event.target.value))} className="ml-2 w-24 border-b border-stone-400 bg-transparent px-1 py-1 font-mono text-sm text-stone-950 outline-none focus:border-green-800" />
          </label>
          <Toggle id="search-all" checked={searchAll} onChange={setSearchAll}>Search all documents</Toggle>
          <Toggle id="deduplicate" checked={deduplicate} onChange={setDeduplicate}>Deduplicate by ID for full results / SQL</Toggle>
          <span className="ml-auto font-mono text-[11px] text-stone-500">available {bounds.min}–{bounds.max}</span>
        </div>
        {searchAll && <p className="mt-3 text-xs text-stone-500">Search all verifies every phrase candidate and can transfer more source data for broad phrase queries.</p>}
        {query.includes('"') && <p className="mt-3 text-xs text-stone-500">Quoted phrases intersect word postings first, then inspect candidate source texts for exact token adjacency. Common words can produce many candidates and touch many Parquet files.</p>}
      </form>

      <div className="mt-4 min-h-10 text-sm" aria-live="polite">
        <strong id="status" className="font-medium text-stone-900">{status}</strong>
        <span id="hydration-status" className="ml-3 text-stone-500">{hydrationLabel}</span>
      </div>

      {failure && <div className="my-3 flex items-start justify-between gap-5 border-l-2 border-red-700 bg-red-50 px-4 py-3 text-sm text-red-950" role="alert">
        <div><strong className="font-semibold">Could not complete the request.</strong><p className="mt-1">{failure.message}</p></div>
        {failure.retryable && <button type="button" disabled={busy} onClick={() => run(false)} className="shrink-0 border border-red-800 px-3 py-1.5 text-xs font-semibold hover:bg-red-100 disabled:opacity-50">Retry</button>}
      </div>}

      {lastWasAll && <div className="mt-5"><Timeline hits={displayHits} /></div>}

      <div className="mt-7 mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Results</h2>
          <p className="mt-1 text-xs text-stone-500">All 14 columns · scroll horizontally · double-click a cell to inspect its full value.</p>
        </div>
        {canLoadMore && <button id="more" type="button" disabled={busy} onClick={() => run(true)} className="border-b border-stone-800 pb-0.5 text-xs font-semibold hover:border-green-800 hover:text-green-800 disabled:opacity-50">Load 50 more</button>}
      </div>

      <div id="results" className="table-shell flex h-[clamp(420px,60vh,720px)] min-h-0 overflow-hidden border border-stone-300 bg-white">
        {data.numRows ? <HighTable
          key={generation.current} data={data} cacheKey="eur-lex-search-results-v2"
          columnConfiguration={COLUMN_CONFIGURATION} focus={false} maxRowNumber={data.numRows}
          overscan={2} padding={5} stringify={stringify} renderCellContent={renderCellContent}
          onDoubleClickCell={(_event, col, row) => inspectCell(col, row)}
          onKeyDownCell={(event, col, row) => { if (event.key === "Enter") inspectCell(col, row); }}
          onError={(error) => {
            setFailure({ message: `A source column could not be loaded: ${error.message}`, retryable: true });
            setStatus("Some columns are temporarily unavailable");
          }}
        /> : <p className="m-auto text-sm text-stone-400">Run a query to populate the table.</p>}
      </div>

      {detail && <section className="mt-4 border border-stone-300 bg-white p-4" aria-live="polite">
        <div className="flex items-center justify-between gap-4 text-sm">
          <strong>{detail.column} · {detail.celex || "document"}</strong>
          <button type="button" onClick={() => setDetail(null)} className="text-xs text-stone-600 underline hover:text-stone-950">Close</button>
        </div>
        <pre className="mt-3 max-h-[38vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-stone-700">{stringify(detail.value)}</pre>
      </section>}

      {rawHits.length > 0 && <AnalysisPanel epoch={analysisEpoch} prepareRows={prepareAnalysisRows} deduplicate={deduplicate} sql={sql} onSqlChange={setSql} />}
    </main>

    <footer className="mx-auto max-w-[1800px] border-t border-stone-300 px-5 py-5 text-xs leading-5 text-stone-500 lg:px-10">Runs entirely in your browser from a <a className="text-stone-800 underline" href="https://github.com/do-me/roaring-static-search">static Roaring index</a>. Exact phrases and visible table rows resolve against immutable source Parquet. The dataset’s normal weekly publisher remains independent.</footer>
  </div>;
}

createRoot(document.querySelector("#root")).render(<App />);
