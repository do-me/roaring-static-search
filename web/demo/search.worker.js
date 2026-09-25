import { StaticSearch } from "../src/index.js";

let search;

function report(id, progress) { self.postMessage({ id, progress }); }
function throttle(id) {
  let last = 0;
  return (progress) => {
    const now = performance.now();
    if (progress.phase === "candidates" || now - last >= 100) {
      last = now;
      report(id, progress);
    }
  };
}

function uniqueById(hits) {
  const seen = new Set();
  return hits.filter((hit) => {
    const id = typeof hit.id === "string" ? hit.id.trim() : hit.id;
    if (id == null || id === "") return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function prepareRows({ hits, request, lastWasAll, deduplicate, columns, verificationBatchSize }, id) {
  let searchRequests = 0;
  let searchBytes = 0;
  if (!lastWasAll) {
    const progressMessage = throttle(id);
    report(id, { message: "Completing the exhaustive exact search…" });
    const answer = await search.search(request.query, {
      limit: null, exhaustive: true, includeMetadata: false, verificationBatchSize,
      yearFrom: request.yearFrom, yearTo: request.yearTo,
      onProgress: (progress) => {
        if (progress.phase === "candidates") progressMessage({ phase: progress.phase, message: `${progress.candidateCount.toLocaleString()} bitmap candidates selected…` });
        else if (progress.requiresPhraseVerification) {
          progressMessage({ phase: progress.phase, message: `Verifying exact phrases · ${progress.processedCandidates.toLocaleString()} / ${progress.candidateCount.toLocaleString()} candidates · ${progress.hits.toLocaleString()} matches` });
        }
      },
    });
    hits = answer.hits;
    searchRequests = answer.networkRequests;
    searchBytes = answer.networkBytes;
  }
  const selected = deduplicate ? uniqueById(hits) : hits;
  if (!selected.length) throw new Error("The exact result set is empty.");
  report(id, { message: `Fetching all 14 source columns for ${selected.length.toLocaleString()} exact rows…` });
  const source = await search.getSourceRows(selected, { columns });
  return {
    rows: source.rows.map((row, index) => ({
      _search_rank: index + 1,
      _search_year: selected[index].year ?? null,
      _search_shard: selected[index].shard,
      _search_doc_id: selected[index].docId,
      _search_external_id: selected[index].id,
      ...row,
    })),
    sourceMatchCount: hits.length,
    duplicatesRemoved: hits.length - selected.length,
    networkRequests: searchRequests + source.networkRequests,
    networkBytes: searchBytes + source.networkBytes,
  };
}

self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    let result;
    if (method === "init") {
      search = new StaticSearch(args[0], { textSources: args[1] });
      await search.ready();
      result = true;
    } else if (method === "search") {
      result = await search.search(args[0], { ...args[1], onProgress: throttle(id) });
    } else if (method === "prepareRowsToPort") {
      const port = args[1];
      try {
        const prepared = await prepareRows(args[0], id);
        const { rows, ...stats } = prepared;
        port.postMessage({ rows });
        result = { ...stats, rowCount: rows.length };
      } catch (error) {
        port.postMessage({ error: error.message });
        throw error;
      } finally {
        port.close();
      }
    } else if (method === "yearBounds") result = await search.yearBounds();
    else if (method === "getSourceRows") result = await search.getSourceRows(args[0], args[1]);
    else throw new Error(`Unknown background search method: ${method}`);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: { name: error.name, message: error.message, status: error.status, retryable: error.retryable } });
  }
};
