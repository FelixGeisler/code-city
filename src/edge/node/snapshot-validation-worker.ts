import { parentPort, workerData } from "node:worker_threads";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SAVE_LIMITS, snapshotHeaderLength, snapshotIdentity, validateSavedHeader, validateNormalizedSource } from "../../application/saved-investigation";

async function validate(file: string) {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > SAVE_LIMITS.snapshot) throw new Error("Invalid snapshot");
    const whole = createHash("sha256"); let offset = 0;
    const read = async (length: number): Promise<Buffer> => {
      const bytes = Buffer.alloc(length); let consumed = 0;
      while (consumed < length) { const result = await handle.read(bytes, consumed, length - consumed, offset + consumed); if (result.bytesRead === 0) throw new Error("Truncated snapshot"); consumed += result.bytesRead; }
      offset += length; whole.update(bytes); return bytes;
    };
    const length = snapshotHeaderLength(await read(12));
    const parsed = validateSavedHeader(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(length))));
    if (stat.size !== 12 + length + parsed.payloadBytes) throw new Error("Snapshot length differs");
    for (const file of parsed.header.files) {
      const entry = file.normalized;
      if (!entry) continue;
      const hash = createHash("sha256"), normalized: Buffer[] = [];
      for (let remaining = entry.length; remaining > 0;) {
        const bytes = await read(Math.min(65536, remaining)); remaining -= bytes.length; hash.update(bytes); normalized.push(bytes);
      }
      if (hash.digest("hex") !== entry.sha256) throw new Error("Snapshot integrity failure");
      validateNormalizedSource(file, Buffer.concat(normalized));
    }
    return { ...snapshotIdentity(parsed.header), sha256: whole.digest("hex"), bytes: stat.size };
  } finally { await handle.close(); }
}
void validate((workerData as { file: string }).file).then(value => parentPort?.postMessage({ ok: true, value }), () => parentPort?.postMessage({ ok: false }));
