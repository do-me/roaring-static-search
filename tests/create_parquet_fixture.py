"""Create tiny Zstandard Parquet input for cross-language integration tests."""

from pathlib import Path
import sys

import pyarrow as pa
import pyarrow.parquet as pq


target = Path(sys.argv[1])
target.parent.mkdir(parents=True, exist_ok=True)
pq.write_table(pa.table({
    "url": ["https://example.test/p1", "https://example.test/p2", "https://example.test/p3"],
    "celex": ["P1", "P2", "P3"],
    "eli": ["https://example.test/eli/p1", None, None],
    "title": ["Exact phrase", "False candidate", "Other"],
    "date": ["2026-01-01", "2026-01-02", "2026-01-03"],
    "lang": ["ENG", "ENG", "ENG"],
    "institutions": [["European Commission"], [], []],
    "work_types": [["proposal"], [], []],
    "procedure_ids": [["2026/0001"], [], []],
    "directory_codes": [["01"], [], []],
    "formats": [["html", "pdf"], ["html"], ["html"]],
    "eurovoc_concepts": [["climate change"], [], []],
    "eurovoc_concepts_ids": [["1001"], [], []],
    "text": ["Copernicus and greenhouse gas", "greenhouse but not gas", "climate change"],
}), target, compression="zstd")
