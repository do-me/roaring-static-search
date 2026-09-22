# Roaring Static Search

Exact Boolean keyword search from a static web page, with no search server. A Python writer turns JSONL or Parquet documents into portable Roaring postings; a small JavaScript/WASM reader fetches only relevant static byte ranges. Quoted phrases use a second stage: candidate documents are checked against their **full text** before appearing in results.

The [experimental EUR-LEX search page](https://do-me.github.io/roaring-static-search/) is deployed from this repository. Its index is a separate `search-index` branch of the EUR-LEX Hugging Face repository; source data and the normal dataset publishing job remain independent. The deployed page uses a phrase-verification batch of 96, the best observed value in the EUR-LEX feasibility benchmark; generic library users retain the conservative default of 64.

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
});
console.log(page.hits, page.nextCursor, page.exactCount);
const fullDocument = await search.getDocument(page.hits[0], { includeText: true });
// For a quoted-phrase query, exactCount is null unless you request
// { exhaustive: true }, which can require downloading many full texts.
```

`AND` binds tighter than `OR`; parentheses and quoted adjacent-token phrases are supported. An unquoted word is a whole token, case-insensitive. The writer and reader lowercase and split on characters outside Unicode letter/number/private-use categories, approximating SQLite FTS5's `unicode61` tokenizer. Thus `"greenhouse gas"` also matches `greenhouse-gas`, and `climate` matches `climate_change`. `NOT`, stemming, diacritic folding, compatibility normalization (e.g. `CO₂` → `co2`), fuzzy matches, implicit AND, and global relevance ranking are not implemented.

By default, `search()` returns IDs quickly. Pass `{ includeMetadata: true }` for titles/other stored fields, or fetch a particular hit with `getDocument(hit, { includeText: true })`. Metadata hydration can take additional HTTP ranges, so it is excluded from the default first-ID timing.

The page has **exact first-page results**: if a quoted phrase yields false-positive bitmap candidates, it fetches and checks further documents until the requested page fills or candidates run out. Bitmap `candidateCount` is not an exact phrase-hit count. `exactCount` is exact immediately for word-only queries; for phrase queries, use `exhaustive: true` at potentially substantial I/O cost. Results are ordered by manifest shard, then local document ID. Duplicate external IDs are not collapsed. `search()` accepts `verificationBatchSize` (default 64); a larger batch makes fewer network rounds but can over-fetch source documents.

## Files and operational trade-offs

Each shard contains 256 SHA-256-bucketed JSON lexicon files, `postings.bin` (concatenated portable Roaring bitmaps), `ids.json.gz` (compact external-ID table), `docs.idx` (fixed-width offsets), and `meta.bin` (JSON metadata). By default, `text.bin` contains individually gzip-compressed **full** texts. With `--external-parquet-text`, `text.bin` is empty and a small `sources.json.gz` maps document IDs to original Parquet file/row locations. The browser fetches and decodes only the necessary source files for phrase verification. A host must support HTTP `Range` requests with `206` and `Content-Range` for the index, plus CORS for a different page origin. The reader fails closed if a host ignores Range.

The default document store duplicates source text to enable independent, exact phrase verification. External Parquet mode removes that duplication but depends on stable, public, browser-readable source files. It currently downloads each selected Parquet file whole because EUR-LEX's small, Zstandard-compressed daily files required fewer requests and bytes than range-reading their text columns in our benchmark. Network work is *not* guaranteed to be 2–3 requests: 10 query terms across two shards can require dozens of parallel requests, and phrase verification can touch many source files. Size, latency, and update time depend on the corpus and host; measure them before production use.

## Test

```bash
uv run pytest -q
npm test
npm run test:browser  # requires Google Chrome on macOS
```

The tests include Python-to-WASM Roaring compatibility, nested AND/OR, false-positive phrase candidates, pagination, Unicode, and a real Chrome static-page smoke test.

See [offline EUR-LEX results](benchmarks/RESULTS.md) for corpus-scale build size, FTS5 parity, and browser timing under a simulated network.

## License

MIT. See [LICENSE](LICENSE).
