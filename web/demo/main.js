import { StaticSearch } from "../src/index.js";

const params = new URLSearchParams(location.search);
const manifestUrl = params.get("manifest") || import.meta.env.VITE_SEARCH_MANIFEST_URL || "/data/manifest.json";
const includeMetadata = params.has("titles") ? params.get("titles") === "1" : import.meta.env.VITE_SEARCH_SHOW_TITLES === "true";
const verificationBatchSize = Number(params.get("verifyBatch") || "64");
const sourceMap = params.get("sourceMap");
const textSources = sourceMap ? {
  [params.get("sourceShard") || "archive"]: {
    mapUrl: sourceMap,
    baseUrl: params.get("sourceBase"),
    mode: params.get("sourceMode") || "whole",
    concurrency: Number(params.get("sourceConcurrency") || "8"),
  },
} : {};
const search = new StaticSearch(new URL(manifestUrl, location.href), { textSources });
const form = document.querySelector("#search-form");
const input = document.querySelector("#query");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const more = document.querySelector("#more");
let cursor = null;
let currentQuery = "";

async function run(append = false) {
  const query = input.value.trim();
  if (!query) return;
  if (!append) {
    results.replaceChildren();
    cursor = null;
    currentQuery = query;
  }
  status.textContent = "Searching…";
  more.hidden = true;
  try {
    const answer = await search.search(currentQuery, { limit: 50, cursor, includeMetadata, verificationBatchSize });
    for (const hit of answer.hits) {
      const li = document.createElement("li");
      const heading = document.createElement("strong");
      heading.textContent = String(hit.id);
      li.append(heading);
      if (hit.title) li.append(document.createTextNode(` — ${hit.title}`));
      const note = document.createElement("small");
      note.textContent = ` [${hit.shard}, document ${hit.docId}]`;
      li.append(note);
      results.append(li);
    }
    cursor = answer.nextCursor;
    more.hidden = !cursor;
    const countLabel = answer.exactCount == null
      ? `${answer.candidateCount} bitmap candidates; exact total requires checking their texts`
      : `${answer.exactCount} exact matches`;
    status.textContent = `${answer.hits.length} results in ${answer.elapsedMs.toFixed(0)} ms; ${countLabel}; ${answer.networkRequests} requests / ${(answer.networkBytes / 1e6).toFixed(2)} MB`;
  } catch (error) {
    status.textContent = `Search failed: ${error.message}`;
    throw error;
  }
}

form.addEventListener("submit", (event) => { event.preventDefault(); run(); });
more.addEventListener("click", () => run(true));
search.ready().then(() => { status.textContent = "Ready"; }, (error) => { status.textContent = `Load failed: ${error.message}`; });
