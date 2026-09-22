"""Compare candidate multisets with the existing local FTS5 reference."""

from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
from collections import Counter
from pathlib import Path

from pyroaring import BitMap

from roaring_static_search.format import bucket


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard", type=Path, required=True)
    parser.add_argument("--fts5", type=Path, required=True)
    args = parser.parse_args()
    ids = json.load(gzip.open(args.shard / "ids.json.gz", "rt", encoding="utf-8"))
    db = sqlite3.connect(f"file:{args.fts5}?mode=ro", uri=True)

    def posting(term: str) -> BitMap:
        entries = json.loads((args.shard / "lexicon" / f"{bucket(term)}.json").read_text(encoding="utf-8"))
        offset, length, _ = entries[term]
        with (args.shard / "postings.bin").open("rb") as source:
            source.seek(offset)
            return BitMap.deserialize(source.read(length))

    for term in ["climate", "gas", "co2", "energy", "environment", "satellite"]:
        ours = Counter(ids[i] for i in posting(term))
        baseline = Counter(row[0] for row in db.execute(
            "SELECT docs.celex FROM body_fts JOIN docs ON docs.id=body_fts.rowid WHERE body_fts MATCH ?", (term,)
        ))
        print(json.dumps({"term": term, "ours": sum(ours.values()), "fts5": sum(baseline.values()),
                          "oursOnly": list((ours - baseline).elements())[:10],
                          "fts5Only": list((baseline - ours).elements())[:10]}))

    words = "climate atmosphere co2 copernicus emissions energy environment temperature satellite".split()
    candidates = BitMap()
    for term in words:
        candidates |= posting(term)
    candidates |= posting("greenhouse") & posting("gas")
    ours = Counter(ids[i] for i in candidates)
    expression = 'climate OR atmosphere OR co2 OR copernicus OR emissions OR energy OR environment OR temperature OR satellite OR "greenhouse gas"'
    baseline = Counter(row[0] for row in db.execute(
        "SELECT docs.celex FROM body_fts JOIN docs ON docs.id=body_fts.rowid WHERE body_fts MATCH ?", (expression,)
    ))
    print(json.dumps({"query": "10-OR candidate vs FTS5 exact", "ours": sum(ours.values()), "fts5": sum(baseline.values()),
                      "oursOnly": list((ours - baseline).elements())[:30],
                      "fts5Only": list((baseline - ours).elements())[:30]}))


if __name__ == "__main__":
    main()
