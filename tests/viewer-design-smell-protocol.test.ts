import { describe, expect, it } from "vitest";
import { isDesignSmellEvaluateRequest, isDesignSmellWorkerResponse } from "../apps/viewer/src/design-smell-protocol.js";
describe("design smell worker protocol", () => {
  it("requires exact request and response schemas", () => {
    expect(isDesignSmellEvaluateRequest({ type: "evaluate", jobId: 1, model: {}, configuration: {}, suppressions: [], extra: true })).toBe(false);
    expect(isDesignSmellWorkerResponse({ type: "failure", jobId: 1, message: "x" })).toBe(true);
    expect(isDesignSmellWorkerResponse({ type: "result", jobId: 1, evaluation: {}, extra: true })).toBe(false);
  });
});
