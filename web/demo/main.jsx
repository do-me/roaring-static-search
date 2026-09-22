import React, { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import HighTable from "hightable";
import "hightable/src/HighTable.css";
import "./style.css";

import { StaticSearch } from "../src/index.js";

const COLUMNS = [
  "url", "celex", "eli", "title", "date", "lang", "institutions",
  "work_types", "procedure_ids", "directory_codes", "formats",
  "eurovoc_concepts", "eurovoc_concepts_ids", "text",
];
const COLUMN_CONFIGURATION = {
  url: { minWidth: 260 },
  celex: { minWidth: 150 },
  eli: { minWidth: 260 },
  title: { minWidth: 420 },
  date: { minWidth: 115 },
  lang: { minWidth: 80 },
  institutions: { minWidth: 220 },
  work_types: { minWidth: 180 },
  procedure_ids: { minWidth: 180 },
  directory_codes: { minWidth: 180 },
  formats: { minWidth: 180 },
  eurovoc_concepts: { minWidth: 360 },
  eurovoc_concepts_ids: { minWidth: 260 },
  text: { minWidth: 560 },
};

const params = new URLSearchParams(location.search);
const manifestUrl = params.get("manifest") || import.meta.env.VITE_SEARCH_MANIFEST_URL || "/data/manifest.json";
const includeMetadata = params.has("titles") ? params.get("titles") === "1" : import.meta.env.VITE_SEARCH_SHOW_TITLES === "true";
const verificationBatchSize = Number(params.get("verifyBatch") || import.meta.env.VITE_SEARCH_VERIFICATION_BATCH_SIZE || "64");
const sourceMap = params.get("sourceMap");
const textSources = sourceMap ? {
  [params.get("sourceShard") || "archive"]: {
    mapUrl: sourceMap,
    baseUrl: params.get("sourceBase"),
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
    this.hits.forEach((hit, row) => this.seed(row, hit));
  }

  get numRows() { return this.hits.length; }

  seed(row, hit) {
    const values = new Map([["celex", hit.id]]);
    for (const column of COLUMNS) if (Object.hasOwn(hit, column)) values.set(column, hit[column]);
    this.cache.set(row, values);
  }

  append(hits) {
    const start = this.hits.length;
    this.hits.push(...hits);
    hits.forEach((hit, index) => this.seed(start + index, hit));
    this.eventTarget.dispatchEvent(new Event("numrowschange"));
    this.eventTarget.dispatchEvent(new Event("resolve"));
  }

  getRowNumber({ row }) {
    return row >= 0 && row < this.hits.length ? { value: row } : undefined;
  }

  getCell({ row, column }) {
    const values = this.cache.get(row);
    return values?.has(column) ? { value: values.get(column) } : undefined;
  }

  fetch({ rowStart, rowEnd, columns = [], signal }) {
    const task = this.queue.catch(() => {}).then(() => this.fetchNow({ rowStart, rowEnd, columns, signal }));
    this.queue = task;
    return task;
  }

  async fetchNow({ rowStart, rowEnd, columns, signal }) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const selectedColumns = [...new Set(columns.filter((column) => COLUMNS.includes(column)))];
    const selectedRows = [];
    for (let row = Math.max(0, rowStart); row < Math.min(rowEnd, this.hits.length); row++) {
      if (selectedColumns.some((column) => !this.cache.get(row)?.has(column))) selectedRows.push(row);
    }
    if (!selectedRows.length || !selectedColumns.length) return;
    const answer = await search.getSourceRows(selectedRows.map((row) => this.hits[row]), { columns: selectedColumns });
    selectedRows.forEach((row, index) => {
      for (const column of selectedColumns) this.cache.get(row).set(column, answer.rows[index]?.[column] ?? null);
    });
    this.networkRequests += answer.networkRequests;
    this.networkBytes += answer.networkBytes;
    this.onHydration?.({ loaded: true, requests: this.networkRequests, bytes: this.networkBytes });
    this.eventTarget.dispatchEvent(new Event("resolve"));
  }
}

function App() {
  const [query, setQuery] = useState('copernicus AND (climate OR "greenhouse gas")');
  const [status, setStatus] = useState("Loading…");
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hydration, setHydration] = useState({ loaded: false, requests: 0, bytes: 0 });
  const [detail, setDetail] = useState(null);
  const generation = useRef(0);
  const activeQuery = useRef("");
  const [data, setData] = useState(() => new SearchResultsDataFrame([], null));

  const newFrame = useCallback((hits) => {
    const current = ++generation.current;
    setHydration({ loaded: false, requests: 0, bytes: 0 });
    const frame = new SearchResultsDataFrame(hits, (value) => {
      if (generation.current === current) setHydration(value);
    });
    setData(frame);
    return frame;
  }, []);

  const run = useCallback(async (append = false) => {
    const clean = append ? activeQuery.current : query.trim();
    if (!clean || busy) return;
    if (!append) activeQuery.current = clean;
    setBusy(true);
    setDetail(null);
    setStatus("Searching…");
    let frame = data;
    if (!append) {
      frame = newFrame([]);
      setCursor(null);
    }
    try {
      const answer = await search.search(clean, {
        limit: 50,
        cursor: append ? cursor : null,
        includeMetadata,
        verificationBatchSize,
      });
      if (append) frame.append(answer.hits);
      else frame = newFrame(answer.hits);
      setCursor(answer.nextCursor);
      const countLabel = answer.exactCount == null
        ? `${answer.candidateCount} bitmap candidates; exact total requires checking their texts`
        : `${answer.exactCount} exact matches`;
      setStatus(`${answer.hits.length} results in ${answer.elapsedMs.toFixed(0)} ms; ${countLabel}; ${answer.networkRequests} requests / ${(answer.networkBytes / 1e6).toFixed(2)} MB`);
    } catch (error) {
      setStatus(`Search failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }, [busy, cursor, data, newFrame, query]);

  React.useEffect(() => {
    search.ready().then(() => setStatus("Ready"), (error) => setStatus(`Load failed: ${error.message}`));
  }, []);

  const inspectCell = useCallback((columnIndex, row) => {
    const cell = data.getCell({ row, column: COLUMNS[columnIndex] });
    if (cell) setDetail({ column: COLUMNS[columnIndex], celex: data.getCell({ row, column: "celex" })?.value, value: cell.value });
  }, [data]);

  const renderCellContent = useCallback(({ cell, col }) => {
    const value = stringify(cell?.value);
    if ((COLUMNS[col] === "url" || COLUMNS[col] === "eli") && value) {
      return <a href={value} target="_blank" rel="noreferrer">{value}</a>;
    }
    return value;
  }, []);

  const hydrationLabel = useMemo(() => hydration.loaded
    ? `Visible source columns: ${hydration.requests} requests / ${(hydration.bytes / 1e6).toFixed(2)} MB (cached while you explore).`
    : "Additional columns load only for visible rows and are cached in this tab.", [hydration]);

  return <>
    <header>
      <div>
        <p className="eyebrow">Static, serverless, experimental</p>
        <h1>EUR-LEX full-text search</h1>
      </div>
      <a className="dataset-link" href="https://huggingface.co/datasets/do-me/EUR-LEX">Dataset ↗</a>
    </header>
    <main>
      <p className="intro">Exact terms, <code>AND</code>, <code>OR</code>, parentheses, and quoted adjacent-token phrases. Try <code>copernicus AND (climate OR "greenhouse gas")</code>.</p>
      <form id="search-form" onSubmit={(event) => { event.preventDefault(); run(false); }}>
        <label htmlFor="query">Boolean query</label>
        <div className="search-row">
          <input id="query" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search query" spellCheck="false" />
          <button type="submit" disabled={busy}>Search</button>
        </div>
      </form>
      <div className="metrics" aria-live="polite">
        <strong id="status">{status}</strong>
        <span id="hydration-status">{hydrationLabel}</span>
      </div>
      <div className="table-heading">
        <div>
          <h2>Results</h2>
          <p>All 14 dataset columns are available. Scroll horizontally; double-click a cell to inspect its complete value.</p>
        </div>
        <button id="more" type="button" hidden={!cursor || query.trim() !== activeQuery.current} disabled={busy} onClick={() => run(true)}>Load 50 more</button>
      </div>
      <div id="results" className="table-shell">
        {data.numRows
          ? <HighTable
              key={generation.current}
              data={data}
              cacheKey="eur-lex-search-results-v1"
              columnConfiguration={COLUMN_CONFIGURATION}
              focus={false}
              maxRowNumber={data.numRows}
              overscan={2}
              padding={5}
              stringify={stringify}
              renderCellContent={renderCellContent}
              onDoubleClickCell={(_event, col, row) => inspectCell(col, row)}
              onKeyDownCell={(event, col, row) => { if (event.key === "Enter") inspectCell(col, row); }}
              onError={(error) => setStatus(`Column load failed: ${error.message}`)}
            />
          : <p className="empty">Run a query to populate the table.</p>}
      </div>
      {detail && <section className="detail" aria-live="polite">
        <div className="detail-heading">
          <strong>{detail.column} · {detail.celex || "document"}</strong>
          <button type="button" onClick={() => setDetail(null)}>Close</button>
        </div>
        <pre>{stringify(detail.value)}</pre>
      </section>}
    </main>
    <footer>Runs entirely in your browser from a <a href="https://github.com/do-me/roaring-static-search">static Roaring index</a>. Exact phrases and table columns resolve against immutable source Parquet; the dataset's normal weekly publisher remains independent.</footer>
  </>;
}

createRoot(document.querySelector("#root")).render(<App />);
