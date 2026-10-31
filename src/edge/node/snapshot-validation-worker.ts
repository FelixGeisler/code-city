import { parentPort, workerData } from "node:worker_threads";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SAVE_LIMITS, snapshotHeaderLength, snapshotIdentity, validateSavedHeader } from "../../application/saved-investigation";

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
      for (const [entry, raw] of [[file.raw, true], [file.normalized, false]] as const) {
        if (!entry) continue;
        const hash = createHash("sha256");
        const git = raw ? createHash(file.blob.length === 40 ? "sha1" : "sha256").update(`blob ${entry.length}\0`) : undefined;
        const normalized: Buffer[] = [];
        for (let remaining = entry.length; remaining > 0;) {
          const bytes = await read(Math.min(65536, remaining)); remaining -= bytes.length; hash.update(bytes); git?.update(bytes); if (!raw) normalized.push(bytes);
        }
        if (hash.digest("hex") !== entry.sha256 || (git && git.digest("hex") !== file.blob)) throw new Error("Snapshot integrity failure");
        if (!raw) {
          const bytes = Buffer.concat(normalized), text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (text.includes("\0") || text.includes("\r") || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) throw new Error("Invalid normalized source");
          const boundary = (index: number) => index === bytes.length || (bytes[index]! & 0xc0) !== 0x80;
          for (const unit of file.units) { if (!boundary(unit[1]) || !boundary(unit[2]) || unit[3].some(value => !boundary(value))) throw new Error("Invalid unit span"); }
          for (const contribution of file.contributions) if (!boundary(contribution[2]) || !boundary(contribution[3])) throw new Error("Invalid contribution span");
        }
      }
    }
    return { ...snapshotIdentity(parsed.header), sha256: whole.digest("hex"), bytes: stat.size };
  } finally { await handle.close(); }
}
void validate((workerData as { file: string }).file).then(value => parentPort?.postMessage({ ok: true, value }), () => parentPort?.postMessage({ ok: false }));
