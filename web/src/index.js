import { RoaringBitmap32, roaringLibraryInitialize } from "roaring-wasm";
import { normalize, parseQuery, queryTerms, matchesText } from "./query.js";

const FORMAT = "roaring-static-search/v1";
const TOKENIZER = "lower-unicode61-like/v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hex(bytes) { return [...bytes].map((n) => n.toString(16).padStart(2, "0")).join(""); }
async function termBucket(term) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(term));
  return hex(new Uint8Array(digest).slice(0, 1));
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== "function") throw new Error("This browser needs DecompressionStream('gzip') for phrase verification");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

class RemoteShard {
  constructor(name, url, manifest, client) {
    if (manifest.format !== FORMAT || manifest.tokenizer !== TOKENIZER || manifest.indexRecordBytes !== 24) {
      throw new Error(`Unsupported shard format or tokenizer: ${url}`);
    }
    this.name = name;
    this.url = url;
    this.manifest = manifest;
    this.client = client;
    this.buckets = new Map();
    this.postings = new Map();
    this.docIndex = null;
    this.idsPromise = null;
    this.metaCache = new Map();
  }

  file(name) { return new URL(name, this.url); }

  async ids() {
    if (!this.idsPromise) {
      this.idsPromise = this.client.getBytes(this.file("ids.json.gz"))
        .then(gunzip).then(JSON.parse).then((ids) => {
          if (!Array.isArray(ids) || ids.length !== this.manifest.documentCount) throw new Error("Invalid ID table");
          return ids;
        });
    }
    return this.idsPromise;
  }

  async bucket(name) {
    if (!this.buckets.has(name)) this.buckets.set(name, this.client.getJson(this.file(`lexicon/${name}.json`)));
    return this.buckets.get(name);
  }

  async posting(term, entry) {
    if (!entry) return new RoaringBitmap32();
    if (!this.postings.has(term)) {
      this.postings.set(term, this.client.getRange(this.file("postings.bin"), entry[0], entry[1])
        .then((bytes) => RoaringBitmap32.deserialize(bytes, "portable")));
    }
    return this.postings.get(term);
  }

  async bitmaps(terms) {
    const lookups = await Promise.all(terms.map(async (term) => [term, (await this.bucket(await termBucket(term)))[term]]));
    const bitmaps = await Promise.all(lookups.map(async ([term, entry]) => [term, await this.posting(term, entry)]));
    return new Map(bitmaps);
  }

  async ensureDocIndex() {
    if (!this.docIndex) {
      const length = this.manifest.files["docs.idx"];
      this.docIndex = length ? this.client.getRange(this.file("docs.idx"), 0, length) : Promise.resolve(new Uint8Array());
    }
    return new DataView((await this.docIndex).buffer);
  }

  async offsets(docId) {
    if (!Number.isInteger(docId) || docId < 0 || docId >= this.manifest.documentCount) throw new RangeError("Invalid document ID");
    const view = await this.ensureDocIndex();
    const pos = docId * 24;
    const metaOffset = Number(view.getBigUint64(pos, true));
    const metaLength = view.getUint32(pos + 8, true);
    const textOffset = Number(view.getBigUint64(pos + 12, true));
    const textLength = view.getUint32(pos + 20, true);
    if (![metaOffset, textOffset].every(Number.isSafeInteger)) throw new Error("Document offset exceeds JS safe integer range");
    return { metaOffset, metaLength, textOffset, textLength };
  }

  async metadata(ids) {
    const unique = [...new Set(ids)];
    const missing = unique.filter((id) => !this.metaCache.has(id));
    if (missing.length) {
      const locations = await Promise.all(missing.map(async (id) => ({ id, ...(await this.offsets(id)) })));
      locations.sort((a, b) => a.metaOffset - b.metaOffset);
      const groups = [];
      for (const item of locations) {
        const last = groups.at(-1);
        const end = item.metaOffset + item.metaLength;
        // Trade modest over-fetch for far fewer high-latency HTTP round trips.
        if (last && end - last.start <= 8 * 1024 * 1024) {
          last.end = end;
          last.items.push(item);
        } else groups.push({ start: item.metaOffset, end, items: [item] });
      }
      await Promise.all(groups.map(async (group) => {
        const bytes = await this.client.getRange(this.file("meta.bin"), group.start, group.end - group.start);
        for (const item of group.items) {
          const start = item.metaOffset - group.start;
          this.metaCache.set(item.id, JSON.parse(decoder.decode(bytes.subarray(start, start + item.metaLength))));
        }
      }));
    }
    return new Map(unique.map((id) => [id, this.metaCache.get(id)]));
  }

  async text(docId) {
    if (this.externalText) {
      const beforeRequests = this.externalText.networkRequests;
      const beforeBytes = this.externalText.networkBytes;
      const value = await this.externalText.text(docId);
      this.client.networkRequests += this.externalText.networkRequests - beforeRequests;
      this.client.networkBytes += this.externalText.networkBytes - beforeBytes;
      return value;
    }
    const { textOffset, textLength } = await this.offsets(docId);
    return gunzip(await this.client.getRange(this.file("text.bin"), textOffset, textLength));
  }

  async texts(ids, { maxGap = 4 * 1024 * 1024, maxSpan = 32 * 1024 * 1024 } = {}) {
    if (!ids.length) return new Map();
    if (this.externalText) {
      const beforeRequests = this.externalText.networkRequests;
      const beforeBytes = this.externalText.networkBytes;
      const values = await this.externalText.texts(ids);
      this.client.networkRequests += this.externalText.networkRequests - beforeRequests;
      this.client.networkBytes += this.externalText.networkBytes - beforeBytes;
      return values;
    }
    const locations = await Promise.all(ids.map(async (id) => ({ id, ...(await this.offsets(id)) })));
    locations.sort((a, b) => a.textOffset - b.textOffset);
    const groups = [];
    for (const item of locations) {
      const end = item.textOffset + item.textLength;
      const last = groups.at(-1);
      if (last && item.textOffset - last.end <= maxGap && end - last.start <= maxSpan) {
        last.end = end;
        last.items.push(item);
      } else groups.push({ start: item.textOffset, end, items: [item] });
    }
    const found = new Map();
    await Promise.all(groups.map(async (group) => {
      const bytes = await this.client.getRange(this.file("text.bin"), group.start, group.end - group.start);
      const decoded = await Promise.all(group.items.map(async (item) => {
        const start = item.textOffset - group.start;
        return [item.id, await gunzip(bytes.subarray(start, start + item.textLength))];
      }));
      for (const [id, text] of decoded) found.set(id, text);
    }));
    return found;
  }

  async sourceRecords(ids, columns) {
    if (this.externalText) {
      const beforeRequests = this.externalText.networkRequests;
      const beforeBytes = this.externalText.networkBytes;
      const values = await this.externalText.records(ids, columns);
      this.client.networkRequests += this.externalText.networkRequests - beforeRequests;
      this.client.networkBytes += this.externalText.networkBytes - beforeBytes;
      return values;
    }
    const metadata = await this.metadata(ids);
    const texts = columns.includes("text") ? await this.texts(ids) : new Map();
    return new Map(ids.map((id) => {
      const stored = metadata.get(id);
      return [id, Object.fromEntries(columns.map((column) => [
        column,
        column === "text" ? texts.get(id) : stored?.[column] ?? null,
      ]))];
    }));
  }
}

function bitmapFor(tree, terms, optimistic) {
  if (tree.type === "term") return terms.get(tree.term).clone();
  if (tree.type === "phrase") {
    if (!optimistic) return new RoaringBitmap32();
    const [first, ...rest] = tree.terms;
    const out = terms.get(first).clone();
    for (const term of rest) out.andInPlace(terms.get(term));
    return out;
  }
  const left = bitmapFor(tree.left, terms, optimistic);
  const right = bitmapFor(tree.right, terms, optimistic);
  if (tree.type === "AND") left.andInPlace(right);
  else left.orInPlace(right);
  right.dispose();
  return left;
}

/** Read-only, serverless Boolean search over one or more static shards. */
export class StaticSearch {
  constructor(manifestUrl, { fetchImpl = (...args) => globalThis.fetch(...args), textSources = {} } = {}) {
    this.url = new URL(String(manifestUrl), globalThis.location?.href || "http://localhost/");
    this.fetchImpl = fetchImpl;
    this.textSources = textSources;
    this.networkRequests = 0;
    this.networkBytes = 0;
    this.readyPromise = null;
  }

  async getJson(url) {
    return JSON.parse(decoder.decode(await this.getBytes(url)));
  }

  async getBytes(url) {
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.networkRequests++;
    this.networkBytes += bytes.length;
    return bytes;
  }

  async getRange(url, offset, length) {
    if (length === 0) return new Uint8Array();
    const end = offset + length - 1;
    const response = await this.fetchImpl(url, { headers: { Range: `bytes=${offset}-${end}` } });
    if (response.status !== 206) throw new Error(`Range request needs HTTP 206, got ${response.status}: ${url}`);
    const contentRange = response.headers.get("Content-Range");
    if (!contentRange?.startsWith(`bytes ${offset}-${end}/`)) throw new Error(`Wrong Content-Range: ${contentRange}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== length) throw new Error(`Wrong range length: expected ${length}, got ${bytes.length}`);
    this.networkRequests++;
    this.networkBytes += bytes.length;
    return bytes;
  }

  ready() {
    if (!this.readyPromise) this.readyPromise = (async () => {
      await roaringLibraryInitialize();
      const root = await this.getJson(this.url);
      if (root.format !== FORMAT || !Array.isArray(root.shards)) throw new Error("Unsupported root manifest");
      this.shards = await Promise.all(root.shards.map(async ({ name, url }) => {
        const shardUrl = new URL(url, this.url);
        const shard = new RemoteShard(name, shardUrl, await this.getJson(shardUrl), this);
        const declared = shard.manifest.externalText;
        const source = this.textSources[name] || (declared && { ...declared, mapUrl: new URL(declared.map, shardUrl) });
        if (source) {
          const { mapUrl, baseUrl, mode, concurrency } = source;
          const { ParquetTextSource } = await import("./parquet_source.js");
          const packed = await this.getBytes(new URL(mapUrl, this.url));
          const map = JSON.parse(await gunzip(packed));
          if (map.documentCount !== shard.manifest.documentCount) throw new Error(`Source map does not match shard ${name}`);
          shard.externalText = new ParquetTextSource(map, new URL(baseUrl, shardUrl),
            { fetchImpl: this.fetchImpl, mode, concurrency });
        }
        return shard;
      }));
      return this;
    })();
    return this.readyPromise;
  }

  /** Fetch one result by its shard-local ID; includeText retrieves full text. */
  async getDocument({ shardIndex, docId }, { includeText = false } = {}) {
    await this.ready();
    const shard = this.shards[shardIndex];
    if (!shard) throw new RangeError("Invalid shard index");
    const meta = (await shard.metadata([docId])).get(docId);
    return { shard: shard.name, shardIndex, docId, ...meta,
      ...(includeText ? { text: await shard.text(docId) } : {}) };
  }

  /** Fetch arbitrary source columns for result hits, preserving hit order. */
  async getSourceRows(hits, { columns } = {}) {
    if (!Array.isArray(hits) || !Array.isArray(columns) || !columns.length) {
      throw new TypeError("hits and a non-empty columns array are required");
    }
    await this.ready();
    const initialRequests = this.networkRequests;
    const initialBytes = this.networkBytes;
    const grouped = new Map();
    hits.forEach((hit, position) => {
      const shard = this.shards[hit.shardIndex];
      if (!shard || !Number.isInteger(hit.docId)) throw new RangeError("Invalid search hit");
      if (!grouped.has(hit.shardIndex)) grouped.set(hit.shardIndex, []);
      grouped.get(hit.shardIndex).push({ position, docId: hit.docId });
    });
    const rows = Array(hits.length);
    await Promise.all([...grouped].map(async ([shardIndex, items]) => {
      const records = await this.shards[shardIndex].sourceRecords(items.map((item) => item.docId), columns);
      for (const { position, docId } of items) {
        const record = records.get(docId) || {};
        rows[position] = Object.fromEntries(columns.map((column) => [
          column,
          column === "celex" && record[column] == null ? hits[position].id : record[column] ?? null,
        ]));
      }
    }));
    return {
      rows,
      networkRequests: this.networkRequests - initialRequests,
      networkBytes: this.networkBytes - initialBytes,
    };
  }

  /** Release cached WASM bitmaps when the reader is no longer needed. */
  async close() {
    if (!this.readyPromise) return;
    await this.readyPromise;
    for (const shard of this.shards) {
      for (const promise of shard.postings.values()) (await promise).dispose();
      shard.postings.clear();
      shard.buckets.clear();
      shard.metaCache.clear();
      shard.externalText?.clear();
    }
    this.shards = [];
    this.readyPromise = null;
  }

  async search(query, { limit = 50, cursor = null, exhaustive = false, includeMetadata = false, verificationBatchSize = 64 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit must be 1..1000");
    if (!Number.isInteger(verificationBatchSize) || verificationBatchSize < 1 || verificationBatchSize > 1000) throw new RangeError("verificationBatchSize must be 1..1000");
    const started = performance.now();
    const initialRequests = this.networkRequests;
    const initialBytes = this.networkBytes;
    await this.ready();
    const tree = parseQuery(query);
    const { terms, hasPhrase } = queryTerms(tree);
    const prepared = await Promise.all(this.shards.map(async (shard) => {
      const termBitmaps = await shard.bitmaps(terms);
      const candidates = bitmapFor(tree, termBitmaps, true);
      const definite = hasPhrase ? bitmapFor(tree, termBitmaps, false) : null;
      const ids = candidates.toArray();
      candidates.dispose();
      return { shard, ids, definite };
    }));
    const candidateCount = prepared.reduce((sum, item) => sum + item.ids.length, 0);
    const hits = [];
    let exactTotal = 0;
    let verifiedTexts = 0;
    let nextCursor = null;
    const startShard = cursor?.shard ?? 0;
    const after = cursor?.after ?? -1;
    if (!Number.isInteger(startShard) || startShard < 0 || startShard >= prepared.length || !Number.isInteger(after)) throw new RangeError("Invalid cursor");
    try {
      outer: for (let shardIndex = startShard; shardIndex < prepared.length; shardIndex++) {
        const { shard, ids, definite } = prepared[shardIndex];
        let i = shardIndex === startShard ? ids.findIndex((id) => id > after) : 0;
        if (i < 0) continue;
        while (i < ids.length) {
          const batch = ids.slice(i, i + verificationBatchSize);
          const uncertain = hasPhrase ? batch.filter((id) => !definite.has(id)) : [];
          const texts = await shard.texts(uncertain, { maxGap: exhaustive ? 0 : 4 * 1024 * 1024 });
          verifiedTexts += uncertain.length;
          for (const id of batch) {
            if (!hasPhrase || definite.has(id) || matchesText(tree, texts.get(id))) {
              exactTotal++;
              if (hits.length < limit) hits.push({ shard: shard.name, shardIndex, docId: id });
            }
            if (hits.length >= limit && !exhaustive) {
              const moreCandidates = ids.at(-1) > id || prepared.slice(shardIndex + 1).some((item) => item.ids.length);
              nextCursor = moreCandidates ? { shard: shardIndex, after: id } : null;
              break outer;
            }
          }
          i += batch.length;
        }
      }
      const grouped = new Map();
      for (const hit of hits) {
        if (!grouped.has(hit.shardIndex)) grouped.set(hit.shardIndex, []);
        grouped.get(hit.shardIndex).push(hit.docId);
      }
      const idTables = new Map(await Promise.all([...grouped].map(async ([index]) => [index, await prepared[index].shard.ids()])));
      for (const hit of hits) hit.id = idTables.get(hit.shardIndex)[hit.docId];
      if (includeMetadata) {
        const metadata = new Map(await Promise.all([...grouped].map(async ([index, ids]) => [index, await prepared[index].shard.metadata(ids)])));
        for (const hit of hits) Object.assign(hit, metadata.get(hit.shardIndex).get(hit.docId));
      }
      return {
        hits,
        candidateCount,
        exactCount: hasPhrase ? (exhaustive && !cursor ? exactTotal : null) : candidateCount,
        verifiedTexts,
        nextCursor,
        elapsedMs: performance.now() - started,
        networkRequests: this.networkRequests - initialRequests,
        networkBytes: this.networkBytes - initialBytes,
      };
    } finally {
      for (const item of prepared) item.definite?.dispose();
    }
  }
}

export { normalize, parseQuery, queryTerms, matchesText } from "./query.js";
