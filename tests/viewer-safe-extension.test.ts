import { describe, expect, it } from "vitest";
import { isSafeExtensionWorkerRequest, isSafeExtensionWorkerResponse } from "../apps/viewer/src/safe-extension-protocol.js";
describe("safe extension worker protocol", () => {
  it("accepts only exact bounded messages", () => { expect(isSafeExtensionWorkerRequest({ type: "cancel", jobId: 1 })).toBe(true); expect(isSafeExtensionWorkerRequest({ type: "cancel", jobId: 1, script: "x" })).toBe(false); expect(isSafeExtensionWorkerResponse({ type: "failure", jobId: 1, message: "no" })).toBe(true); expect(isSafeExtensionWorkerResponse({ type: "result", jobId: 1, evaluation: {}, extra: true })).toBe(false); });
});
