"""Compare one live Roaring term posting with an exact local DuckDB scan.

Run from a checkout that has DuckDB available, for example:
  uv run --with duckdb python benchmarks/copernicus_parity.py \
    --dataset-root /path/to/EUR-LEX
"""

from __future__ import annotations

import argparse
import bisect
import gzip
import hashlib
import json
import time
import urllib.request
from collections import Counter
from pathlib import Path
from urllib.parse import urljoin

import duckdb
from pyroaring import BitMap


DEFAULT_MANIFEST = "https://huggingface.co/datasets/do-me/EUR-LEX/resolve/search-index/search/roaring/v1/manifest.json"


def fetch(url: str, byte_range: tuple[int, int] | None = None) -> bytes:
    request = urllib.request.Request(url)
    if byte_range:
        start, length = byte_range
        request.add_header("Range", f"bytes={start}-{start + length - 1}")
    with urllib.request.urlopen(request, timeout=60) as response:
        if byte_range and response.status != 206:
            raise RuntimeError(f"Range request returned HTTP {response.status}: {url}")
        return response.read()


def live_posting(manifest_url: str, term: str) -> tuple[dict[tuple[str, int], str | None], int]:
    root = json.loads(fetch(manifest_url))
    bucket = hashlib.sha256(term.encode()).digest()[:1].hex()
    found: dict[tuple[str, int], str | None] = {}
    documents = 0
    for shard_entry in root["shards"]:
        shard_url = urljoin(manifest_url, shard_entry["url"])
        shard = json.loads(fetch(shard_url))
        documents += shard["documentCount"]
        lexicon = json.loads(fetch(urljoin(shard_url, f"lexicon/{bucket}.json")))
        posting_entry = lexicon.get(term)
        if not posting_entry:
            continue
        posting = BitMap.deserialize(fetch(urljoin(shard_url, "postings.bin"), (posting_entry[0], posting_entry[1])))
        source_map = json.loads(gzip.decompress(fetch(urljoin(shard_url, shard["externalText"]["map"]))))
        ids = json.loads(gzip.decompress(fetch(urljoin(shard_url, "ids.json.gz"))))
        starts = [file[0] for file in source_map["files"]]
        for doc_id in posting:
            file = source_map["files"][bisect.bisect_right(starts, doc_id) - 1]
            found[(file[2], doc_id - file[0])] = ids[doc_id]
    return found, documents


def local_scan(dataset_root: Path, term: str) -> tuple[dict[tuple[str, int], str | None], int]:
    root = dataset_root.resolve()
    parquet_glob = str(root / "files" / "**" / "*.parquet")
    escaped = term.replace("\\", "\\\\").replace("'", "''")
    # This matches roaring-static-search's token boundaries for this ASCII term:
    # Unicode letters, numbers, and private-use characters remain inside tokens.
    pattern = rf"(?i)(^|[^\p{{L}}\p{{N}}\p{{Co}}]){escaped}($|[^\p{{L}}\p{{N}}\p{{Co}}])"
    connection = duckdb.connect()
    connection.execute("PRAGMA threads=8")
    total = connection.execute(
        "SELECT count(*) FROM read_parquet(?, union_by_name=true)", [parquet_glob]
    ).fetchone()[0]
    rows = connection.execute(
        """
        SELECT filename, file_row_number, celex
        FROM read_parquet(?, union_by_name=true, filename=true, file_row_number=true)
        WHERE regexp_matches(coalesce(text, ''), ?)
        """,
        [parquet_glob, pattern],
    ).fetchall()
    connection.close()
    found = {}
    for filename, row, celex in rows:
        relative = Path(filename).resolve().relative_to(root).as_posix()
        found[(relative, int(row))] = celex
    return found, total


def summarize(rows: dict[tuple[str, int], str | None]) -> dict[str, object]:
    ids = Counter(value for value in rows.values() if value)
    return {
        "matches": len(rows),
        "nonempty_ids": sum(ids.values()),
        "unique_nonempty_ids": len(ids),
        "duplicate_nonempty_id_rows": sum(count - 1 for count in ids.values()),
        "blank_ids": sum(not value for value in rows.values()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--term", default="copernicus")
    args = parser.parse_args()
    started = time.perf_counter()
    live, live_documents = live_posting(args.manifest, args.term.casefold())
    after_live = time.perf_counter()
    local, local_documents = local_scan(args.dataset_root, args.term)
    finished = time.perf_counter()
    live_only = sorted(live.keys() - local.keys())
    local_only = sorted(local.keys() - live.keys())
    common = live.keys() & local.keys()
    id_disagreements = sorted(key for key in common if (live[key] or "") != (local[key] or ""))
    result = {
        "term": args.term,
        "live_index_documents": live_documents,
        "local_dataset_documents": local_documents,
        "live_index": summarize(live),
        "local_duckdb": summarize(local),
        "same_source_rows": not live_only and not local_only,
        "common_source_rows": len(common),
        "live_only_count": len(live_only),
        "local_only_count": len(local_only),
        "id_disagreement_count": len(id_disagreements),
        "live_only_sample": [[path, row, live[(path, row)]] for path, row in live_only[:20]],
        "local_only_sample": [[path, row, local[(path, row)]] for path, row in local_only[:20]],
        "id_disagreement_sample": [
            [path, row, live[(path, row)], local[(path, row)]]
            for path, row in id_disagreements[:20]
        ],
        "live_seconds": round(after_live - started, 3),
        "duckdb_seconds": round(finished - after_live, 3),
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
