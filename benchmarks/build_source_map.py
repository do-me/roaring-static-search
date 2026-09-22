"""Map shard-local document IDs to their original Parquet file and row.

This assumes the shard was built from the same sorted Parquet glob. It does
not copy any source text. Run against the exact corpus snapshot used to build
the shard, and pin source URLs to an immutable repository revision.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from roaring_static_search.builder import build_parquet_source_map
import glob


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet-glob", required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--shard", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    paths = [Path(path) for path in sorted(glob.glob(args.parquet_glob, recursive=True))]
    manifest = json.loads((args.shard / "shard.json").read_text(encoding="utf-8"))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    print(json.dumps(build_parquet_source_map(paths, args.root, args.out, manifest["documentCount"])))


if __name__ == "__main__":
    main()
