"""CLI for independently rebuildable static index shards."""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import uuid
from pathlib import Path

from .builder import add_ids_file, build_shard, jsonl_records, parquet_records
from .format import FORMAT


def main() -> None:
    parser = argparse.ArgumentParser(prog="roaring-static-search")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="Build a new immutable shard")
    source = build.add_mutually_exclusive_group(required=True)
    source.add_argument("--jsonl", type=Path)
    source.add_argument("--parquet-glob", help="Quoted glob, e.g. 'files/2026/*.parquet'")
    build.add_argument("--out", type=Path, required=True)
    build.add_argument("--id-field", default="id")
    build.add_argument("--text-field", default="text")
    build.add_argument("--metadata-fields", nargs="*", default=[])
    build.add_argument("--gzip-level", type=int, default=1)
    build.add_argument("--max-documents", type=int)
    manifest = sub.add_parser("manifest", help="Write a multi-shard root manifest")
    manifest.add_argument("--out", type=Path, required=True)
    manifest.add_argument("shards", nargs="+", help="NAME=relative/path/to/shard.json")
    add_ids = sub.add_parser("add-ids", help="Add compact ID table to an existing shard")
    add_ids.add_argument("--shard", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "build":
        if args.out.exists():
            parser.error(f"Refusing to overwrite {args.out}")
        if args.jsonl:
            records = jsonl_records(args.jsonl)
        else:
            paths = [Path(path) for path in sorted(glob.glob(args.parquet_glob, recursive=True))]
            if not paths:
                parser.error(f"No Parquet files matched {args.parquet_glob!r}")
            columns = list(dict.fromkeys([args.id_field, args.text_field, *args.metadata_fields]))
            records = parquet_records(paths, columns)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        staging = args.out.with_name(f".{args.out.name}-{uuid.uuid4().hex}.building")
        try:
            build_shard(records, staging, id_field=args.id_field, text_field=args.text_field,
                        metadata_fields=args.metadata_fields, gzip_level=args.gzip_level,
                        max_documents=args.max_documents)
            os.replace(staging, args.out)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    elif args.command == "add-ids":
        print(json.dumps({"idsBytes": add_ids_file(args.shard)}))
    else:
        entries = []
        names = set()
        for spec in args.shards:
            if "=" not in spec:
                parser.error(f"Expected NAME=PATH, got {spec!r}")
            name, path = spec.split("=", 1)
            if not name or not path or name in names:
                parser.error(f"Invalid or repeated shard name: {name!r}")
            names.add(name)
            entries.append({"name": name, "url": path})
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({"format": FORMAT, "shards": entries}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
