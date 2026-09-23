# EUR-LEX offline prototype results (2026-09-22)

This is a **local feasibility test**, not a Hugging Face CDN or GitHub Actions measurement. The indexed snapshot contained 330,163 documents and 7,808,096,664 uncompressed UTF-8 text bytes. The commands in this directory reproduce the query tests when supplied with the same source corpus and an FTS5 reference database.

## Build and storage

| Item | Observation |
| --- | ---: |
| Full-corpus build, Apple M3 Max laptop | 558 s |
| Documents / distinct tokens | 330,163 / 3,593,891 |
| Roaring postings | 328,883,146 bytes |
| 256 lexicon buckets | 110,268,330 bytes |
| Document offsets, metadata, IDs | 128,448,324 bytes |
| Individually gzip-compressed full texts | 2,652,001,618 bytes |
| Complete static artifact | 3,219,601,418 bytes (3.00 GiB) |
| Independently rebuilt 2026 shard (3,415 docs) | 8.1–8.3 s; byte-identical on repeat |

These numbers contradict the idea that the entire index would be under 200 MB or that rebuilding the full archive would take a few seconds. The postings plus lexicon alone are 439 MB; exact phrase verification requires the separate 2.65 GB full-text store. The 2026 result is a **local** incremental-shard feasibility check, not a GitHub CI benchmark. The writer does not append documents to one monolithic file: it rebuilds only affected immutable shards and publishes a new root manifest last.

## Correctness against the existing FTS5 baseline

Counts use `search(query, { exhaustive: true })`, which checks all uncertain phrase candidates; a normal first-page query does not do that work. Query syntax and tokenizer behavior are documented in the root README.

| Query | Roaring candidates | Exact matches | FTS5 exact matches |
| --- | ---: | ---: | ---: |
| `copernicus AND climate` | 763 | 763 | 763 |
| `climate OR atmosphere OR "greenhouse gas" OR CO2` | 26,427 | 26,361 | 26,361 |
| `copernicus AND (climate OR atmosphere OR "greenhouse gas" OR CO2)` | 781 | 781 | 781 |
| Ten-way OR including `"greenhouse gas"` | 80,766 | 80,758 | 80,758 |

Six individual term postings also matched FTS5 document frequencies and external IDs exactly. In the ten-way OR, the eight candidate-only documents were phrase false positives; there were no FTS5-only documents. This validates these queries on this snapshot, not every possible Unicode/FTS5 query.

## Query-submit-to-results benchmark

Actual headless Google Chrome loaded the demo page and initialized the reader. Each query used a fresh browser context, then the clock started at form submission and stopped when the first 50 results were rendered. The local HTTP Range server added **600 ms per response**, and Chrome was throttled to **10 MiB/s download**. This models network cost but is not a measurement of the Hugging Face host, CORS policy, cache, or real-world connection limits.

| Query | IDs only | IDs + titles |
| --- | ---: | ---: |
| `copernicus AND climate` | 2.71 s | 7.74 s |
| `climate OR atmosphere OR "greenhouse gas" OR CO2` | 4.65 s | 6.74 s |
| `copernicus AND (climate OR atmosphere OR "greenhouse gas" OR CO2)` | 5.28 s | 10.33 s |
| Ten-way OR including `"greenhouse gas"` | 9.10 s | 11.12 s |
| `"greenhouse gas"` alone | 17.94 s | 19.31 s |

The ten-way OR used `climate`, `atmosphere`, `co2`, `copernicus`, `emissions`, `energy`, `environment`, `temperature`, `satellite`, and `"greenhouse gas"`. The phrase-only titles run required 21 HTTP requests and transferred 124.7 MB because the reader coalesced scattered full-text ranges to reduce round trips. That query has almost no margin under a 20-second target; it may exceed it on the actual CDN. Mixed queries can be faster because word-only branches provide many **definite** matches that require no text fetch.

The browser benchmark can be rerun against a built local index with:

```bash
node benchmarks/browser_queries.js --data-dir /absolute/path/to/data \
  --delay-ms 600 --bandwidth-mibps 10 --metadata
node benchmarks/validate_counts.js /absolute/path/to/data
```

Pass a data directory containing `manifest.json` and the referenced shard directories. For IDs-only timing, omit `--metadata`. An actual hosted end-to-end benchmark and CI runtime/limits test are intentionally deferred until productionization is approved.

## Source-backed phrase verification (follow-up)

The original EUR-LEX Parquet files already contain the text, so duplicating it is **not necessary** when source files remain accessible at an immutable revision. A sorted-file/row locator for this full snapshot is only **152,762 bytes gzipped** (13,545 nonempty Parquet files). Keeping the other full-corpus files unchanged and omitting `text.bin` projects a **567,752,562-byte** static search artifact (about 542 MiB), down from 3.00 GiB. This is a storage calculation using the measured files; the complete archive was not rebuilt in the new mode. A 6,507-document 1996 shard **was** built in both modes: external source took 4.82 s and 13 MiB on disk (`text.bin` empty, source map 3,010 bytes), versus 5.59 s and 47 MiB bundled (34,652,636-byte `text.bin`). These are laptop timings, not GitHub CI timings.

Direct browser fetch and Zstandard decoding worked against an actual revision-pinned Hugging Face Parquet URL. For the phrase-only first page, 128 bundled source texts were compared byte-for-byte with texts fetched from 82 Hugging Face Parquet files; **all 128 matched**. The source URL revision used for this check was `4c51d3968f5914322a229509d40921295c4c9e58`. Production indexing must pin the same revision as the files used to build the index.

The next table uses the same real-Chrome/local-server simulation as above (600 ms per response, 10 MiB/s downlink), stopping when 50 IDs are rendered. `whole` fetches each selected source Parquet file once and decodes its text column; `range` asks for the Parquet text-column ranges. The original bundled mode uses 64-candidate batches.

| Phrase-only `"greenhouse gas"` strategy | Batch | Submit-to-50 IDs | Requests | Transfer |
| --- | ---: | ---: | ---: | ---: |
| Bundled compressed texts | 64 | 17.9 s | 20 | 116.7 MB |
| External Parquet, range reads | 64 | 22.4 s | 170 | 52.3 MB |
| External Parquet, whole files | 64 | 13.6 s | 87 | 45.5 MB |
| External Parquet, whole files | 32 | 11.9 s | 68 | 37.2 MB |
| External Parquet, whole files | **96** | **10.9 s** | **67** | **36.1 MB** |
| External Parquet, whole files | 128 | 13.4 s | 87 | 45.5 MB |

With titles, external whole-file mode at batch 64 took 16.4 s versus 19.3 s bundled. The four mixed/word-heavy queries above had essentially unchanged first-page timings in external mode because their first 50 hits did not require phrase verification. Page initialization under the simulation took 3.73 s external versus 2.48 s bundled; despite that extra source-map/decoder load, phrase-only **page-open-to-50-IDs** fell from about 20.3 s to 14.7 s with the 96-candidate batch.

In two real Hugging Face fetch runs with the index served locally (not hosted on Hugging Face), phrase-only external whole-file verification took 10.5 s for 50 IDs at batch 64 and 6.3 s for 50 IDs plus titles at batch 96. CDN/browser caches and network conditions varied, so these are feasibility observations, not a guaranteed production SLA. At that stage, the full lean index had not yet been deployed or tested in GitHub CI.

## Hosted Hightable follow-up

The full textless index was subsequently deployed to the dataset's `search-index` branch. It contains 330,209 documents in a 550 MiB static artifact; the separate GitHub Actions bootstrap completed in 18m22s and an unchanged weekly update completed as a 10-second no-op. The GitHub Page now uses Hightable and searches IDs first, then loads all 14 source columns for only the virtualized viewport rows. The measurements below used fresh browser contexts, a 1600×1000 viewport, the live Hugging Face index/source files, and no artificial throttling.

| Query | First 50 IDs | Visible rows with all 14 columns | Source-column transfer |
| --- | ---: | ---: | ---: |
| `copernicus AND climate` | 1.85 s | 3.68 s | 11 requests / 9.25 MB |
| `climate OR atmosphere OR "greenhouse gas" OR CO2` | 2.30 s | 4.32 s | 17 requests / 5.28 MB |
| Ten-way OR including `"greenhouse gas"` | 3.13 s | 4.32 s | 12 requests / 3.25 MB |
| `"greenhouse gas"` | 6.69 s | 7.51 s | 0 additional requests / 0 MB |

The phrase-only table needed no additional column transfer because phrase verification had already fetched and cached the relevant whole Parquet files. Timings vary with CDN cache and connection conditions; they demonstrate the deployed path rather than a guaranteed SLA.

## Exact live-index parity audit (2026-09-23)

`benchmarks/copernicus_parity.py` compared the live `copernicus` posting with a DuckDB regex scan over all 19,587 local source files. Both returned the same **1,019 physical source rows**: 899 unique nonblank external IDs and 120 rows with blank IDs. There were no live-only rows, local-only rows, duplicate nonblank IDs, or ID disagreements. The live manifest contained 330,209 documents while the local snapshot contained 330,163; none of the 46 additional live documents matched `copernicus`. The live fetch/mapping took 28.2 seconds and the local full scan 9.0 seconds in this run.

## Parquet physical-layout audit (2026-09-23)

All 19,587 local files report Parquet file version 1.0, were written by Polars, use Zstandard, share one schema, and contain 330,163 rows / 6,710,151,560 bytes. The median file has only 6 rows and is 80,255 bytes. The files contain 1.21 GB of serialized footers plus additional page-index/structural data. Full-text min/max statistics can be enormous: in one inspected file the `text` maximum alone was 1,241,181 bytes.

A non-destructive rewrite of all 365 files in the 2025 partition produced the following exact-row-equivalent results:

| Writer/options | Parquet file version | Bytes |
| --- | ---: | ---: |
| Existing Polars, statistics enabled | 1.0 | 265,018,759 |
| Same Polars/Zstd, statistics disabled | 1.0 | **80,357,017** |
| PyArrow via Polars, statistics retained except `text` | 1.0 | 94,352,817 |
| PyArrow via Polars, statistics retained except `text` | 2.6 | 94,356,788 |

Changing only PyArrow's logical-type version from 1.0 to 2.6 changed this partition by about 4 KB; enabling Data Page V2 also had a negligible size effect. PyArrow, DuckDB, and the browser's hyparquet reader successfully read the tested 1.0, 2.6, and Data Page V2 outputs with equal row/ID/text aggregates. A warm DuckDB full-text scan of the partition took about 0.12 seconds for every variant. The material optimization is therefore suppressing unhelpful `text` statistics/page indexes, not raising the nominal Parquet version. No dataset files or publisher settings were changed during this audit.
