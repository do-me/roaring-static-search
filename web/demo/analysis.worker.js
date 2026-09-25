import { BrowserAnalysis } from "../src/duckdb_analysis.js";
import { barsFromRows } from "../src/chart_data.js";

let analysis;

self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    let result;
    if (method === "createFromPort") {
      const port = args[0];
      try {
        const rows = await new Promise((resolve, reject) => {
          port.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.rows);
          port.onmessageerror = () => reject(new Error("Could not transfer source rows to DuckDB."));
          port.start();
        });
        analysis = await BrowserAnalysis.create(rows);
        result = true;
      } finally {
        port.close();
      }
    } else if (method === "preview") result = await analysis.preview(args[0]);
    else if (method === "chart") {
      const output = await analysis.chartRows(args[0]);
      result = { ...barsFromRows(output.rows, args[1], args[2]), outputRows: output.rows.length };
    }
    else if (method === "export") result = await analysis.export(args[0], args[1]);
    else if (method === "close") { await analysis?.close(); analysis = null; result = true; }
    else throw new Error(`Unknown background analysis method: ${method}`);
    self.postMessage({ id, result }, result?.bytes ? [result.bytes.buffer] : []);
  } catch (error) {
    self.postMessage({ id, error: { name: error.name, message: error.message } });
  }
};
