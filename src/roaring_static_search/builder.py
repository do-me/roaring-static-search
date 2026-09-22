"""One-pass document store and exact term-to-document Roaring index builder."""

from __future__ import annotations

import gzip
import json
import struct
import time
from collections.abc import Iterable, Iterator, Mapping
from pathlib import Path
from typing import Any

from pyroaring import BitMap

from .format import FORMAT, INDEX_RECORD_BYTES, TOKENIZER, bucket, tokens


def add_ids_file(output: Path) -> int:
    """Create compact external-ID table from an existing completed shard."""
    manifest_path = output / "shard.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    count = manifest["documentCount"]
    with (output / "docs.idx").open("rb") as index_file, (output / "meta.bin").open("rb") as meta_file, (output / "ids.json.gz").open("wb") as raw_file:
        with gzip.GzipFile(filename="", fileobj=raw_file, mode="wb", compresslevel=1, mtime=0) as ids_file:
            ids_file.write(b"[")
            for doc_id in range(count):
                row = index_file.read(INDEX_RECORD_BYTES)
                if len(row) != INDEX_RECORD_BYTES:
                    raise ValueError("Truncated document index")
                meta_offset, meta_length, _, _ = struct.unpack("<QIQI", row)
                meta_file.seek(meta_offset)
                meta = json.loads(meta_file.read(meta_length))
                if doc_id:
                    ids_file.write(b",")
                ids_file.write(json.dumps(meta["id"], ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))
            ids_file.write(b"]")
    size = (output / "ids.json.gz").stat().st_size
    manifest["files"]["ids.json.gz"] = size
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return size


def jsonl_records(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: expected a JSON object")
            yield value


def parquet_records(paths: Iterable[Path], columns: list[str]) -> Iterator[dict[str, Any]]:
    import pyarrow.parquet as pq

    for path in paths:
        source = pq.ParquetFile(path)
        available = set(source.schema_arrow.names)
        required = columns[:2]
        missing = [column for column in required if column not in available]
        if missing:
            raise ValueError(f"{path}: missing required columns {missing}")
        selected = [column for column in columns if column in available]
        for batch in source.iter_batches(batch_size=128, columns=selected):
            data = batch.to_pydict()
            for row in range(batch.num_rows):
                yield {column: data[column][row] for column in selected}


def build_shard(
    records: Iterable[Mapping[str, Any]],
    output: Path,
    *,
    id_field: str = "id",
    text_field: str = "text",
    metadata_fields: list[str] | None = None,
    gzip_level: int = 1,
    max_documents: int | None = None,
) -> dict[str, Any]:
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite {output}")
    if not 0 <= gzip_level <= 9:
        raise ValueError("gzip_level must be in 0..9")
    output.mkdir(parents=True)
    (output / "lexicon").mkdir()
    postings: dict[str, BitMap] = {}
    count = 0
    uncompressed_text_bytes = 0
    started = time.perf_counter()
    fields = list(dict.fromkeys(metadata_fields or []))

    with (output / "docs.idx").open("wb") as index_file, (output / "meta.bin").open(
        "wb"
    ) as meta_file, (output / "text.bin").open("wb") as text_file:
        for record in records:
            if max_documents is not None and count >= max_documents:
                break
            if id_field not in record or text_field not in record:
                raise ValueError(f"Record {count + 1} lacks {id_field!r} or {text_field!r}")
            body = record[text_field]
            if body is None:
                body = ""
            if not isinstance(body, str):
                raise TypeError(f"Record {count + 1} text must be a string")
            doc_id = count
            meta = {"id": record[id_field]}
            for field in fields:
                if field not in (id_field, text_field) and field in record:
                    meta[field] = record[field]
            meta_bytes = json.dumps(meta, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
            text_bytes = body.encode("utf-8")
            packed_text = gzip.compress(text_bytes, compresslevel=gzip_level, mtime=0)
            meta_offset = meta_file.tell()
            text_offset = text_file.tell()
            meta_file.write(meta_bytes)
            text_file.write(packed_text)
            index_file.write(struct.pack("<QIQI", meta_offset, len(meta_bytes), text_offset, len(packed_text)))
            uncompressed_text_bytes += len(text_bytes)
            for term in set(tokens(body)):
                bitmap = postings.get(term)
                if bitmap is None:
                    bitmap = BitMap()
                    postings[term] = bitmap
                bitmap.add(doc_id)
            count += 1
            if count % 10_000 == 0:
                print(json.dumps({"event": "documents", "count": count, "terms": len(postings), "seconds": round(time.perf_counter() - started, 2)}), flush=True)

    if (output / "docs.idx").stat().st_size != count * INDEX_RECORD_BYTES:
        raise RuntimeError("Document index size mismatch")

    buckets: dict[str, dict[str, list[int]]] = {f"{i:02x}": {} for i in range(256)}
    with (output / "postings.bin").open("wb") as posting_file:
        for term in sorted(postings):
            bitmap = postings[term]
            bitmap.run_optimize()
            payload = bitmap.serialize()
            offset = posting_file.tell()
            posting_file.write(payload)
            buckets[bucket(term)][term] = [offset, len(payload), len(bitmap)]
        for name, entries in buckets.items():
            (output / "lexicon" / f"{name}.json").write_text(
                json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
            )

    manifest = {
        "format": FORMAT,
        "tokenizer": TOKENIZER,
        "documentCount": count,
        "termCount": len(postings),
        "indexRecordBytes": INDEX_RECORD_BYTES,
        "compression": "gzip",
        "files": {name: (output / name).stat().st_size for name in ("postings.bin", "docs.idx", "meta.bin", "text.bin")},
        "uncompressedTextBytes": uncompressed_text_bytes,
    }
    (output / "shard.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    add_ids_file(output)
    manifest["files"]["ids.json.gz"] = (output / "ids.json.gz").stat().st_size
    print(json.dumps({"event": "complete", "documents": count, "terms": len(postings), "seconds": round(time.perf_counter() - started, 2), "files": manifest["files"]}), flush=True)
    return manifest
