import gzip
import hashlib
import json
import struct
import subprocess
import sys

from pyroaring import BitMap

from roaring_static_search.builder import build_shard, jsonl_records
from roaring_static_search.format import bucket, tokens


def test_tokenizer():
    assert tokens("Café GREENHOUSE-gas CO₂ climate_change") == ["café", "greenhouse", "gas", "co₂", "climate", "change"]


def test_build_portable_postings_and_document_store(tmp_path):
    source = tmp_path / "input.jsonl"
    source.write_text('{"id":"a","title":"First","text":"greenhouse gas climate"}\n'
                      '{"id":"b","title":"Second","text":"greenhouse ... gas"}\n', encoding="utf-8")
    target = tmp_path / "index"
    manifest = build_shard(jsonl_records(source), target, metadata_fields=["title"])
    assert manifest["documentCount"] == 2
    assert manifest["termCount"] == 3
    entries = json.loads((target / "lexicon" / f"{bucket('greenhouse')}.json").read_text())
    offset, length, frequency = entries["greenhouse"]
    assert frequency == 2
    with (target / "postings.bin").open("rb") as source_file:
        source_file.seek(offset)
        assert list(BitMap.deserialize(source_file.read(length))) == [0, 1]
    doc_index = (target / "docs.idx").read_bytes()
    assert len(doc_index) == 48
    meta_offset, meta_length, text_offset, text_length = struct.unpack_from("<QIQI", doc_index, 0)
    assert json.loads((target / "meta.bin").read_bytes()[meta_offset:meta_offset + meta_length]) == {"id": "a", "title": "First"}
    assert gzip.decompress((target / "text.bin").read_bytes()[text_offset:text_offset + text_length]) == b"greenhouse gas climate"
    assert json.loads(gzip.decompress((target / "ids.json.gz").read_bytes())) == ["a", "b"]


def test_cli_does_not_publish_partial_shard(tmp_path):
    source = tmp_path / "broken.jsonl"
    source.write_text('{"id":"first","text":"good"}\n{"id":"second"}\n', encoding="utf-8")
    target = tmp_path / "index"
    run = subprocess.run([sys.executable, "-m", "roaring_static_search.cli", "build",
                          "--jsonl", str(source), "--out", str(target)], capture_output=True, text=True)
    assert run.returncode != 0
    assert not target.exists()
    assert not list(tmp_path.glob("*.building"))


def test_same_inputs_produce_identical_static_files(tmp_path):
    records = [{"id": "a", "text": "climate greenhouse gas", "title": "A"},
               {"id": "b", "text": "CO2 and atmosphere", "title": "B"}]
    left, right = tmp_path / "left", tmp_path / "right"
    build_shard(records, left, metadata_fields=["title"])
    build_shard(records, right, metadata_fields=["title"])
    def hashes(directory):
        return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in directory.rglob("*") if path.is_file()}
    assert hashes(left) == hashes(right)
