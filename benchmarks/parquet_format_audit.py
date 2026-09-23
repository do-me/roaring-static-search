"""Summarize physical Parquet metadata without reading column data.

Example:
  uv run --extra parquet python benchmarks/parquet_format_audit.py /path/to/EUR-LEX/files
"""

from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq


def summary(values: list[int]) -> dict[str, int | float]:
    return {
        "min": min(values),
        "median": statistics.median(values),
        "max": max(values),
        "total": sum(values),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    paths = sorted(args.root.rglob("*.parquet"))
    if not paths:
        raise SystemExit(f"No Parquet files below {args.root}")

    versions: Counter[str] = Counter()
    writers: Counter[str] = Counter()
    compressions: Counter[str] = Counter()
    encodings: Counter[str] = Counter()
    schemas: Counter[str] = Counter()
    file_bytes: list[int] = []
    file_rows: list[int] = []
    row_group_rows: list[int] = []
    row_groups = 0
    serialized_footer_bytes = 0
    compressed_column_chunk_bytes = 0
    columns_with_statistics = 0
    columns_without_statistics = 0

    for path in paths:
        parquet = pq.ParquetFile(path)
        metadata = parquet.metadata
        versions[metadata.format_version] += 1
        writers[metadata.created_by or "unknown"] += 1
        schemas[str(parquet.schema_arrow)] += 1
        file_bytes.append(path.stat().st_size)
        file_rows.append(metadata.num_rows)
        row_groups += metadata.num_row_groups
        serialized_footer_bytes += metadata.serialized_size
        for row_group_index in range(metadata.num_row_groups):
            row_group = metadata.row_group(row_group_index)
            row_group_rows.append(row_group.num_rows)
            for column_index in range(row_group.num_columns):
                column = row_group.column(column_index)
                compressed_column_chunk_bytes += column.total_compressed_size
                compressions[column.compression] += 1
                encodings.update(column.encodings)
                if column.statistics is None:
                    columns_without_statistics += 1
                else:
                    columns_with_statistics += 1

    print(json.dumps({
        "files": len(paths),
        "file_bytes": summary(file_bytes),
        "file_rows": summary(file_rows),
        "row_groups": row_groups,
        "row_group_rows": summary(row_group_rows),
        "serialized_footer_bytes": serialized_footer_bytes,
        "compressed_column_chunk_bytes": compressed_column_chunk_bytes,
        "other_file_bytes": sum(file_bytes) - serialized_footer_bytes - compressed_column_chunk_bytes,
        "format_versions": versions,
        "created_by": writers,
        "compressions_by_column_chunk": compressions,
        "encodings_by_column_chunk": encodings,
        "columns_with_statistics": columns_with_statistics,
        "columns_without_statistics": columns_without_statistics,
        "distinct_schemas": len(schemas),
    }, indent=2))


if __name__ == "__main__":
    main()
