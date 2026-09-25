import { WorkerRpc } from "./worker_rpc.js";

/** Keep bitmap evaluation, phrase checks, and Parquet decoding off the UI thread. */
export class SearchClient {
  constructor(manifestUrl, textSources) {
    this.rpc = new WorkerRpc(new Worker(new URL("./search.worker.js", import.meta.url), { type: "module" }));
    this.initialized = this.rpc.request("init", [String(manifestUrl), textSources]);
  }

  ready() { return this.initialized; }
  async yearBounds() { await this.ready(); return this.rpc.request("yearBounds"); }
  async search(query, options) {
    await this.ready();
    const { onProgress, ...plainOptions } = options;
    return this.rpc.request("search", [query, plainOptions], onProgress);
  }
  async getSourceRows(hits, options) {
    await this.ready();
    return this.rpc.request("getSourceRows", [hits, options]);
  }
  async prepareRowsToPort(options, port, onProgress) {
    await this.ready();
    return this.rpc.request("prepareRowsToPort", [options, port], onProgress, [port]);
  }
}
