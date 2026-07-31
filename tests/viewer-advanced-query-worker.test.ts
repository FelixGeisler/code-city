import { describe, expect, it } from "vitest";
import type {
  AdvancedQueryWorkerResponse,
} from "../apps/viewer/src/advanced-query-protocol.js";
import {
  installAdvancedQueryWorker,
  isDedicatedAdvancedQueryWorkerScope,
  type AdvancedQueryWorkerScope,
} from "../apps/viewer/src/advanced-query-worker.js";

describe("advanced query worker", () => {
  it("returns a bounded failure for malformed requests with a valid job id", () => {
    let listener:
      | ((event: { readonly data: unknown }) => void)
      | undefined;
    const posted: AdvancedQueryWorkerResponse[] = [];
    const scope: AdvancedQueryWorkerScope = {
      importScripts: () => undefined,
      postMessage: (response) => posted.push(response),
      addEventListener: (_type, value) => {
        listener = value;
      },
      removeEventListener: (_type, value) => {
        if (listener === value) listener = undefined;
      },
    };
    expect(isDedicatedAdvancedQueryWorkerScope(scope)).toBe(true);
    expect(
      isDedicatedAdvancedQueryWorkerScope({
        ...scope,
        document: {},
      }),
    ).toBe(false);

    const uninstall = installAdvancedQueryWorker(scope);
    listener?.({
      data: {
        type: "evaluate",
        jobId: 17,
        model: {},
        definition: {},
        context: {
          changes: null,
          smellRules: [
            [
              "building:test",
              Array.from(
                { length: 65 },
                (_, index) => `rule:${index}`,
              ),
            ],
          ],
          availableSmellRules: null,
          ruleSchemaVersion: null,
        },
      },
    });
    expect(posted).toEqual([
      {
        type: "failure",
        jobId: 17,
        message:
          "The advanced query worker received an invalid request.",
      },
    ]);

    listener?.({
      data: {
        type: "evaluate",
        jobId: 0,
        context: {},
      },
    });
    expect(posted).toHaveLength(1);
    uninstall();
    expect(listener).toBeUndefined();
  });
});
