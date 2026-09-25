import { WorkerRpc } from "./worker_rpc.js";

/** DuckDB setup, JSON serialization, Arrow conversion, and exports stay off the UI thread. */
export class AnalysisClient {
  constructor() {
    this.rpc = new WorkerRpc(new Worker(new URL("./analysis.worker.js", import.meta.url), { type: "module" }));
  }

  createFromPort(port) { return this.rpc.request("createFromPort", [port], null, [port]); }
  preview(sql) { return this.rpc.request("preview", [sql]); }
  chart(sql, xAxis, yAxis) { return this.rpc.request("chart", [sql, xAxis, yAxis]); }
  export(sql, format) { return this.rpc.request("export", [sql, format]); }
  close() { this.rpc.stop(); }
}
