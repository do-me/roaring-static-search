import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

/** Retrieve phrase-verification texts directly from immutable source Parquet. */
export class ParquetTextSource {
  constructor(map, baseUrl, { fetchImpl = (...args) => fetch(...args), mode = "whole", concurrency = 8 } = {}) {
    if (map.format !== "roaring-parquet-source/v1" || !Array.isArray(map.files)) throw new Error("Invalid Parquet source map");
    if (!["whole", "range"].includes(mode)) throw new Error(`Unknown Parquet source mode: ${mode}`);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new RangeError("concurrency must be 1..64");
    this.map = map;
    this.baseUrl = String(baseUrl).replace(/\/?$/, "/");
    this.fetchImpl = fetchImpl;
    this.mode = mode;
    this.concurrency = concurrency;
    this.networkRequests = 0;
    this.networkBytes = 0;
    this.fileBuffers = new Map();
  }

  locate(docId) {
    if (!Number.isInteger(docId) || docId < 0 || docId >= this.map.documentCount) throw new RangeError("Invalid document ID");
    const files = this.map.files;
    let lo = 0;
    let hi = files.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (files[mid][0] <= docId) lo = mid + 1;
      else hi = mid;
    }
    const file = files[lo - 1];
    if (!file || docId >= file[0] + file[1]) throw new Error(`Missing Parquet location for ${docId}`);
    return { file, row: docId - file[0] };
  }

  async request(url, start = null, end = null) {
    const ranged = start !== null;
    if (ranged && start === end) return new ArrayBuffer(0);
    const response = await this.fetchImpl(url, ranged ? { headers: { Range: `bytes=${start}-${end - 1}` } } : undefined);
    if (response.status !== (ranged ? 206 : 200)) throw new Error(`Parquet fetch returned HTTP ${response.status}: ${url}`);
    if (ranged && !response.headers.get("Content-Range")?.startsWith(`bytes ${start}-${end - 1}/`)) {
      throw new Error(`Incorrect Parquet Content-Range: ${url}`);
    }
    const bytes = await response.arrayBuffer();
    if (ranged && bytes.byteLength !== end - start) throw new Error("Unexpected Parquet range length");
    this.networkRequests++;
    this.networkBytes += bytes.byteLength;
    return bytes;
  }

  wholeFile(file, url) {
    if (!this.fileBuffers.has(file)) {
      const pending = this.request(url).catch((error) => {
        this.fileBuffers.delete(file);
        throw error;
      });
      this.fileBuffers.set(file, pending);
    }
    return this.fileBuffers.get(file);
  }

  async readFile(file, selections, columns) {
    const url = new URL(file[2].split("/").map(encodeURIComponent).join("/"), this.baseUrl);
    let buffer;
    if (this.mode === "whole") buffer = await this.wholeFile(file, url);
    else buffer = {
      byteLength: file[3],
      slice: (start, end = file[3]) => this.request(url, start, end),
    };
    const rowStart = Math.min(...selections.map((item) => item.row));
    const rowEnd = Math.max(...selections.map((item) => item.row)) + 1;
    const rows = await parquetReadObjects({ file: buffer, columns, rowStart, rowEnd, compressors });
    if (rows.length !== rowEnd - rowStart) throw new Error("Parquet row range was incomplete");
    return selections.map((item) => [item.id, rows[item.row - rowStart]]);
  }

  async records(ids, columns) {
    if (!Array.isArray(columns) || !columns.length || columns.some((column) => typeof column !== "string" || !column)) {
      throw new TypeError("columns must be a non-empty array of names");
    }
    columns = [...new Set(columns)];
    const groups = new Map();
    for (const id of ids) {
      const { file, row } = this.locate(id);
      if (!groups.has(file)) groups.set(file, []);
      groups.get(file).push({ id, row });
    }
    const work = [...groups];
    const found = new Map();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, work.length) }, async () => {
      while (cursor < work.length) {
        const [file, selections] = work[cursor++];
        for (const [id, record] of await this.readFile(file, selections, columns)) found.set(id, record);
      }
    });
    await Promise.all(workers);
    return found;
  }

  async texts(ids) {
    const records = await this.records(ids, ["text"]);
    return new Map([...records].map(([id, record]) => [id, record.text ?? ""]));
  }

  async text(id) { return (await this.texts([id])).get(id); }

  clear() { this.fileBuffers.clear(); }
}
