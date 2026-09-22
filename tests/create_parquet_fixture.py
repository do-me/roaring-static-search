"""Create tiny Zstandard Parquet input for cross-language integration tests."""

from pathlib import Path
import sys

import pyarrow as pa
import pyarrow.parquet as pq


target = Path(sys.argv[1])
target.parent.mkdir(parents=True, exist_ok=True)
pq.write_table(pa.table({
    "celex": ["P1", "P2", "P3"],
    "title": ["Exact phrase", "False candidate", "Other"],
    "text": ["Copernicus and greenhouse gas", "greenhouse but not gas", "climate change"],
}), target, compression="zstd")
