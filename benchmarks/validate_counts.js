import { StaticSearch } from "../web/src/index.js";
import { startDemoServer } from "../web/demo/server.js";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("Usage: node benchmarks/validate_counts.js /path/to/data-dir");
const queries = [
  'copernicus AND climate',
  'climate OR atmosphere OR "greenhouse gas" OR CO2',
  'copernicus AND (climate OR atmosphere OR "greenhouse gas" OR CO2)',
  'climate OR atmosphere OR co2 OR copernicus OR emissions OR energy OR environment OR temperature OR satellite OR "greenhouse gas"',
];
const server = await startDemoServer({ dataDir });
try {
  const search = new StaticSearch(`http://127.0.0.1:${server.address().port}/data/manifest.json`);
  for (const query of queries) {
    const answer = await search.search(query, { exhaustive: true, limit: 50 });
    console.log(JSON.stringify({ query, candidates: answer.candidateCount, exactCount: answer.exactCount, verifiedTexts: answer.verifiedTexts, elapsedMs: Math.round(answer.elapsedMs), networkRequests: answer.networkRequests, networkBytes: answer.networkBytes }));
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
