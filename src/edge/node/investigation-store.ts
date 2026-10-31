import { mkdir, readdir, readFile, lstat, realpath, rename, rm, open } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SAVE_LIMITS, hasSaveCapacity, parseSavedRecord, validSavedId, type SavedRecord } from "../../application/saved-investigation";

export type InvestigationStore = { handle(request: IncomingMessage, response: ServerResponse, reject?: (status: number) => void): Promise<void>; close(): Promise<void> };
const validReceipt = (value: unknown): boolean => { try { parseSavedRecord(value); return true; } catch { return false; } };
function finish(response: ServerResponse, status: number, value?: unknown): void {
  response.statusCode = status; response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
  if (value === undefined) { response.setHeader("Content-Length", "0"); response.end(); }
  else { const bytes = Buffer.from(JSON.stringify(value)); response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Content-Length", bytes.length); response.end(bytes); }
}
export async function openInvestigationStore(directory: string | undefined, artifactRoot: string): Promise<InvestigationStore> {
  let available = false, closing = false, writing = false, readers = 0;
  const workers = new Set<Worker>(); const controllers = new Set<AbortController>(); const jobs = new Set<Promise<void>>();
  const root = directory ? path.resolve(directory) : undefined;
  let catalog: SavedRecord[] = [];
  const snapshots = root ? path.join(root, "snapshots") : "";
  const lock = root ? path.join(root, "write-lock") : "";
  const scan = async (): Promise<void> => {
    if (!root) return;
    const entries = await readdir(snapshots);
    if (entries.length > SAVE_LIMITS.count) throw new Error("Storage inventory exceeds limit");
    const next: SavedRecord[] = [];
    for (const id of entries) {
      if (!validSavedId(id)) throw new Error("Invalid storage entry");
      const dir = path.join(snapshots, id);
      if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) throw new Error("Invalid storage directory");
      const receiptPath = path.join(dir, "record.json"), file = path.join(dir, "snapshot.ccs");
      const receiptStat = await lstat(receiptPath), sourceStat = await lstat(file);
      if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 16384 || !sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("Invalid storage files");
      const record = JSON.parse(await readFile(receiptPath, "utf8")) as SavedRecord;
      if (!validReceipt(record) || record.id !== id || sourceStat.size !== record.bytes) throw new Error("Invalid storage receipt");
      next.push(record);
    }
    catalog = next.sort((a, b) => a.savedAt === b.savedAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.savedAt > b.savedAt ? -1 : 1);
  };
  if (root) {
    try {
      const relative = path.relative(path.resolve(artifactRoot), root);
      if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Data directory must be outside artifact");
      await mkdir(root, { recursive: true });
      if ((await lstat(root)).isSymbolicLink()) throw new Error("Data directory cannot be a link");
      await mkdir(snapshots, { recursive: true });
      if ((await lstat(snapshots)).isSymbolicLink()) throw new Error("Snapshot directory cannot be a link");
      const physical = path.relative(await realpath(artifactRoot), await realpath(root));
      if (physical === "" || (!physical.startsWith(".." + path.sep) && physical !== ".." && !path.isAbsolute(physical))) throw new Error("Data directory aliases artifact");
      await scan(); available = true;
    } catch { available = false; }
  }
  const validate = (file: string): Promise<Omit<SavedRecord, "id" | "savedAt">> => new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./snapshot-validation-worker.js", import.meta.url), { workerData: { file }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    workers.add(worker);
    let result: { ok: boolean; value: Omit<SavedRecord, "id" | "savedAt"> } | undefined, fault: Error | undefined;
    const terminate = (): void => { void worker.terminate().catch(error => { fault = error instanceof Error ? error : new Error("Validation termination failed"); }); };
    worker.once("message", (message: typeof result) => { result = message; terminate(); });
    worker.once("error", error => { fault = error; terminate(); });
    worker.once("exit", () => { workers.delete(worker); if (fault || !result?.ok) reject(fault ?? new Error("Snapshot validation unavailable")); else resolve(result.value); });
  });
  const handle = async (request: IncomingMessage, response: ServerResponse, reject?: (status: number) => void): Promise<void> => {
    const deny = (status: number): void => {
      if (reject) { reject(status); return; }
      response.shouldKeepAlive = false; response.setHeader("Connection", "close"); response.once("finish", () => request.destroy()); finish(response, status);
    };
    if (!available || closing) { if (request.method === "POST") deny(503); else finish(response, 503); return; }
    if (request.url === "/api/investigations" && request.method === "GET") { finish(response, 200, catalog); return; }
    if (request.method === "GET" && request.url?.endsWith("/record")) {
      const id = request.url.slice("/api/investigations/".length, -"/record".length);
      const record = catalog.find(value => value.id === id);
      finish(response, record ? 200 : 404, record); return;
    }
    const id = request.url?.slice("/api/investigations/".length);
    if (request.method === "GET" && validSavedId(id)) {
      const record = catalog.find(value => value.id === id);
      if (!record) { finish(response, 404); return; }
      if (readers >= 4) { finish(response, 503); return; }
      readers++;
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), SAVE_LIMITS.operationMs);
      try {
        const file = path.join(snapshots, id, "snapshot.ccs"), metadata = await lstat(file);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== record.bytes) { finish(response, 409); return; }
        response.statusCode = 200; response.setHeader("Content-Type", "application/octet-stream"); response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Length", record.bytes); response.setHeader("X-Code-City-Sha256", record.sha256);
        await pipeline(createReadStream(file), response, { signal: controller.signal });
      } catch { if (!response.headersSent) finish(response, 409); else response.destroy(); }
      finally { clearTimeout(timer); controllers.delete(controller); readers--; }
      return;
    }
    if (request.url !== "/api/investigations" || request.method !== "POST") { finish(response, 405); return; }
    if (writing) { deny(503); return; }
    const lengthValue = request.headers["content-length"];
    const length = typeof lengthValue === "string" && /^(?:0|[1-9][0-9]*)$/u.test(lengthValue) ? Number(lengthValue) : NaN;
    if (!Number.isSafeInteger(length) || length <= 12 || length > SAVE_LIMITS.snapshot || request.headers["transfer-encoding"] !== undefined) { deny(413); return; }
    if (request.headers["content-type"] !== "application/octet-stream") { deny(415); return; }
    writing = true;
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => { controller.abort(); for (const worker of workers) void worker.terminate().catch(() => {}); }, SAVE_LIMITS.operationMs);
    let owned = false, staging: string | undefined, completed: SavedRecord | undefined;
    try {
      try { await mkdir(lock); owned = true; } catch { deny(503); return; }
      await scan();
      const used = catalog.reduce((sum, value) => sum + value.bytes + 16384, 0);
      if (!hasSaveCapacity(catalog.length, used, length)) { deny(507); return; }
      const id = randomBytes(32).toString("base64url");
      staging = path.join(root!, `staging-${id}`); await mkdir(staging);
      const file = path.join(staging, "snapshot.ccs"); let bytes = 0;
      const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > length ? new Error("Body exceeds declared length") : null, chunk); } });
      await pipeline(request, bound, createWriteStream(file, { flags: "wx" }), { signal: controller.signal });
      if (bytes !== length || controller.signal.aborted) throw new Error("Incomplete upload");
      const value = await validate(file);
      if (controller.signal.aborted || closing) throw new Error("Save cancelled");
      const receipt: SavedRecord = { id, savedAt: new Date().toISOString(), ...value };
      if (!validReceipt(receipt)) throw new Error("Invalid receipt");
      const dataHandle = await open(file, "r+"); try { await dataHandle.sync(); } finally { await dataHandle.close(); }
      const receiptHandle = await open(path.join(staging, "record.json"), "wx");
      try { await receiptHandle.writeFile(JSON.stringify(receipt) + "\n"); await receiptHandle.sync(); } finally { await receiptHandle.close(); }
      if (controller.signal.aborted || closing) throw new Error("Save cancelled");
      await rename(staging, path.join(snapshots, id)); staging = undefined;
      catalog.unshift(receipt); completed = receipt;
    } catch { /* A failed Save never publishes an incomplete directory. */ }
    finally {
      clearTimeout(timer); controllers.delete(controller);
      let cleanupFailed = false;
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => { cleanupFailed = true; });
      // Retain the lock if an owned staging directory cannot be removed. Further
      // failed uploads must not accumulate uncharged bytes beyond the budget.
      if (owned && !cleanupFailed) await rm(lock, { recursive: true }).catch(() => {});
      writing = false;
    }
    if (!response.destroyed && !response.headersSent) finish(response, completed ? 201 : 422, completed);
  };
  return {
    handle(request, response, reject) { const job = handle(request, response, reject); jobs.add(job); void job.then(() => jobs.delete(job), () => jobs.delete(job)); return job; },
    async close() { closing = true; for (const controller of controllers) controller.abort(); await Promise.all([...workers].map(worker => worker.terminate())); await Promise.allSettled([...jobs]); },
  };
}
