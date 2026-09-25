/** Small request/response bridge for the demo's dedicated workers. */
export class WorkerRpc {
  constructor(worker) {
    this.worker = worker;
    this.pending = new Map();
    this.nextId = 1;
    worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.progress) {
        pending.onProgress?.(data.progress);
        return;
      }
      this.pending.delete(data.id);
      if (data.error) {
        const error = new Error(data.error.message);
        Object.assign(error, data.error);
        pending.reject(error);
      } else pending.resolve(data.result);
    };
    worker.onerror = (event) => {
      this.stop(new Error(event.message || "The background worker stopped unexpectedly."));
    };
  }

  request(method, args = [], onProgress, transfer = []) {
    if (!this.worker) return Promise.reject(new Error("The background worker is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try { this.worker.postMessage({ id, method, args }, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  stop(reason = new Error("The background task was cancelled.")) {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    for (const { reject } of this.pending.values()) reject(reason);
    this.pending.clear();
  }
}
