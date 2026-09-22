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

## Page-open-to-results benchmark

Actual headless Google Chrome loaded the demo page and initialized the reader. Each query used a fresh browser context, then the clock started at form submission and stopped when the first 50 results were rendered. The local HTTP Range server added **600 ms per response**, and Chrome was throttled to **10 MiB/s download**. This models network cost but is not a measurement of the Hugging Face host, CORS policy, cache, or real-world connection limits.

| Query | IDs only | IDs + titles |
| --- | ---: | ---: |
| `copernicus AND climate` | 2.66 s | 7.69 s |
| `climate OR atmosphere OR "greenhouse gas" OR CO2` | 4.60 s | 6.68 s |
| `copernicus AND (climate OR atmosphere OR "greenhouse gas" OR CO2)` | 5.26 s | 10.27 s |
| Ten-way OR including `"greenhouse gas"` | 9.07 s | 11.04 s |
| `"greenhouse gas"` alone | not rerun after text-range optimization | 19.34 s |

The ten-way OR used `climate`, `atmosphere`, `co2`, `copernicus`, `emissions`, `energy`, `environment`, `temperature`, `satellite`, and `"greenhouse gas"`. The phrase-only titles run required 21 HTTP requests and transferred 124.7 MB because the reader coalesced scattered full-text ranges to reduce round trips. That query has almost no margin under a 20-second target; it may exceed it on the actual CDN. Mixed queries can be faster because word-only branches provide many **definite** matches that require no text fetch.

The browser benchmark can be rerun against a built local index with:

```bash
node benchmarks/browser_queries.js --data-dir /absolute/path/to/data \
  --delay-ms 600 --bandwidth-mibps 10 --metadata
node benchmarks/validate_counts.js /absolute/path/to/data
```

Pass a data directory containing `manifest.json` and the referenced shard directories. For IDs-only timing, omit `--metadata`. An actual hosted end-to-end benchmark and CI runtime/limits test are intentionally deferred until productionization is approved.
