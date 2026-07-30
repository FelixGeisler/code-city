import { parentPort } from "node:worker_threads";

import type { IdentityLogoFormat } from "../../core/src/index.js";
import { convertLogoToPrintRelief } from "./logo-relief-converter.js";

interface ConversionRequest {
  readonly bytes: Uint8Array;
  readonly format: IdentityLogoFormat;
}

if (parentPort === null) {
  throw new Error("Logo relief worker requires a parent port.");
}

parentPort.once("message", (request: ConversionRequest) => {
  try {
    parentPort!.postMessage({
      ok: true,
      relief: convertLogoToPrintRelief(
        new Uint8Array(request.bytes),
        request.format,
      ),
    });
  } catch {
    parentPort!.postMessage({ ok: false });
  }
});
