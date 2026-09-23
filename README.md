# Roaring Static Search

Exact Boolean keyword search from a static web page, with no search server. A Python writer turns JSONL or Parquet documents into portable Roaring postings; a small JavaScript/WASM reader fetches only relevant static byte ranges. Quoted phrases use a second stage: candidate documents are checked against their **full text** before appearing in results.

The [EUR-LEX search page](https://do-me.github.io/roaring-static-search/) is deployed from this repository. Its index is a separate `search-index` branch of the EUR-LEX Hugging Face repository; source data and the normal dataset publishing job remain independent. Search results are displayed with [Hightable](https://github.com/hyparam/hightable). Its virtualized DataFrame resolves all 14 EUR-LEX columns only for viewport rows, directly from immutable source Parquet, and caches each fetched source file in the browser tab. The deployed page uses a phrase-verification batch of 96, the best observed value in the EUR-LEX feasibility benchmark; generic library users retain the conservative default of 64.

After a search, the page can complete the exhaustive exact result set, hydrate every source column, and create a private DuckDB-Wasm table named `search_results`. SQL previews and full-query Parquet, CSV, and Excel exports run in the browser. DuckDB is lazy-loaded only when the analysis workspace is requested; very broad result sets remain subject to browser memory limits.

The demo keeps its query, inclusive year bounds, search-all and deduplication choices, and any edited SQL in the URL (`q`, `from`, `to`, `all`, `dedupe`, and `sql`). Reloading or sharing that URL restores the controls without automatically rerunning a potentially expensive search. Light, dark, and automatic colour preferences are kept locally in the browser.

## Build an index

```bash
uv sync --extra parquet --extra test

# JSONL: one object per line, with at least id and text
uv run roaring-static-search build \
  --jsonl examples/documents.jsonl --out site/data/archive \
  --metadata-fields title url

# Or Parquet: quote the glob so the CLI receives it
uv run roaring-static-search build \
  --parquet-glob 'files/2026/*.parquet' --out site/data/2026 \
  --id-field celex --text-field text \
  --metadata-fields title date url

# If the original Parquet files remain publicly readable, avoid copying text.
# The source URL must be pinned to the same immutable dataset revision.
uv run roaring-static-search build \
  --parquet-glob '/absolute/path/to/dataset/files/2026/*.parquet' \
  --out site/data/2026 \
  --id-field celex --text-field text --metadata-fields title date url \
  --external-parquet-text \
  --source-root /absolute/path/to/dataset \
  --source-base-url 'https://huggingface.co/datasets/OWNER/DATASET/resolve/COMMIT_SHA/'

uv run roaring-static-search manifest --out site/data/manifest.json \
  archive=archive/shard.json year2026=2026/shard.json
```

Each shard has its own document IDs (0, 1, …); shard order in the root manifest determines result order. To update one year, build that year's shard from its current source files and replace only that shard. Publish immutable/revision-pinned shard URLs and the updated root manifest **last**, so in-flight HTTP Range reads cannot mix index versions. For external text, pin the Parquet source URL to the **same source snapshot used during indexing**, since row numbers can change. At a year boundary, update both years while your data pipeline can still change prior-year documents.
The CLI builds into a temporary sibling directory and moves the complete shard into place only after success; it refuses to overwrite an existing output.

## Search in a browser

```bash
npm install
npm run build:demo
npm run serve:demo -- --data-dir /absolute/path/to/site/data
# Open http://127.0.0.1:8000/
```

Or import the reader into your own bundled page:

```js
import { StaticSearch } from "roaring-static-search";

const search = new StaticSearch("https://static.example/data/manifest.json");
const page = await search.search('copernicus AND (climate OR "greenhouse gas")', {
  limit: 50,
  yearFrom: 2015,
  yearTo: 2026,
  onProgress: ({ phase, processedCandidates, candidateCount }) => {
    if (phase === "verification") console.log(processedCandidates, candidateCount);
  },
});
console.log(page.hits, page.nextCursor, page.exactCount);
const fullDocument = await search.getDocument(page.hits[0], { includeText: true });
const sourceRows = await search.getSourceRows(page.hits, {
  columns: ["celex", "title", "institutions", "eurovoc_concepts", "text"],
});
// For a quoted-phrase query, exactCount is null unless you request
// { exhaustive: true }, which can require downloading many full texts.
// Use { limit: null } to return every exact match; this implies exhaustive.
```

`AND` binds tighter than `OR`; parentheses and quoted adjacent-token phrases are supported. An unquoted word is a whole token, case-insensitive. The writer and reader lowercase and split on characters outside Unicode letter/number/private-use categories, approximating SQLite FTS5's `unicode61` tokenizer. Thus `"greenhouse gas"` also matches `greenhouse-gas`, and `climate` matches `climate_change`. `NOT`, stemming, diacritic folding, compatibility normalization (e.g. `CO₂` → `co2`), fuzzy matches, implicit AND, and global relevance ranking are not implemented.

By default, `search()` returns IDs quickly. Pass `{ includeMetadata: true }` for index-stored fields, fetch one hit with `getDocument(hit, { includeText: true })`, or use `getSourceRows(hits, { columns })` to retrieve arbitrary fields from source-backed Parquet. Metadata hydration can take additional requests, so it is excluded from the default first-ID timing. The deployed Hightable UI deliberately searches IDs first, then hydrates all columns for only its virtualized viewport rows.

The page has **exact first-page results**: if a quoted phrase yields false-positive bitmap candidates, it fetches and checks further documents until the requested page fills or candidates run out. Bitmap `candidateCount` is not an exact phrase-hit count. `exactCount` is exact immediately for word-only queries; for phrase queries, use `exhaustive: true` at potentially substantial I/O cost. Passing `limit: null` returns all exact matches and implies exhaustive phrase verification. Results are ordered by manifest shard, then local document ID. Duplicate external IDs are not collapsed by the library; the demo's search-all view can collapse them by external ID. `search()` accepts `verificationBatchSize` (default 64); a larger batch makes fewer network rounds but can over-fetch source documents.

`yearFrom` and `yearTo` are inclusive. For early shard pruning, add `yearStart` and `yearEnd` to each entry in the root manifest. With external Parquet source maps, document IDs are also filtered to exact source years before phrase verification or result hydration. EUR-LEX uses immutable five-year historical shards plus one replaceable shard per recent year, balancing fewer HTTP requests against useful year pruning.

## Files and operational trade-offs

Each shard contains 256 SHA-256-bucketed JSON lexicon files, `postings.bin` (concatenated portable Roaring bitmaps), `ids.json.gz` (compact external-ID table), `docs.idx` (fixed-width offsets), and `meta.bin` (JSON metadata). By default, `text.bin` contains individually gzip-compressed **full** texts. With `--external-parquet-text`, `text.bin` is empty and a small `sources.json.gz` maps document IDs to original Parquet file/row locations. The browser fetches and decodes only the necessary source files for phrase verification. A host must support HTTP `Range` requests with `206` and `Content-Range` for the index, plus CORS for a different page origin. The reader fails closed if a host ignores Range.

The default document store duplicates source text to enable independent, exact phrase verification. External Parquet mode removes that duplication but depends on stable, public, browser-readable source files. It currently downloads each selected Parquet file whole because EUR-LEX's small, Zstandard-compressed daily files required fewer requests and bytes than range-reading their text columns in our benchmark. Whole-file buffers are reused by phrase verification and Hightable column hydration, so a phrase result already fetched from Parquet incurs no second transfer when its other columns appear. Network work is *not* guaranteed to be 2–3 requests: 10 query terms across two shards can require dozens of parallel requests, and phrase verification can touch many source files. Size, latency, and update time depend on the corpus and host; measure them before production use.

## Test

```bash
uv run pytest -q
npm test
npm run test:browser  # requires Google Chrome on macOS
```

The tests include Python-to-WASM Roaring compatibility, nested AND/OR, false-positive phrase candidates, pagination, Unicode, and a real Chrome static-page smoke test.

For corpus audits, `benchmarks/copernicus_parity.py` compares a live single-term posting with a full local DuckDB scan, while `benchmarks/parquet_format_audit.py` reports physical Parquet versions, compression, encodings, row groups, and metadata size without reading column data.

See [offline EUR-LEX results](benchmarks/RESULTS.md) for corpus-scale build size, FTS5 parity, and browser timing under a simulated network.

## License

MIT. See [LICENSE](LICENSE).
