import { describe, expect, it, vi } from "vitest";

import {
  ImportApiError,
  type ImportAuthorizationStatus,
  type ImportCredentialProfile,
  type ImportJob,
  type ImportUploadReservation,
} from "../apps/viewer/src/import-api.js";
import {
  ImportController,
  LocalImportJobStorage,
  type ImportControllerState,
  type ImportJobStorage,
  type ViewerImportApi,
} from "../apps/viewer/src/import-controller.js";
import { DEMO_MODEL } from "../apps/viewer/src/demo-model.js";
import { ViewerLoadGateway } from "../apps/viewer/src/model-source.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const VIEWER_URL = new URL("https://city.example.test/");
const CREATED_AT = "2026-07-30T10:00:00.000Z";
const TRUSTED: ImportAuthorizationStatus = {
  mode: "trusted-network",
  required: false,
  authenticated: false,
};
const AUTHENTICATED: ImportAuthorizationStatus = {
  mode: "shared-secret",
  required: true,
  authenticated: true,
};
const UNAUTHENTICATED: ImportAuthorizationStatus = {
  mode: "shared-secret",
  required: true,
  authenticated: false,
};
const PROFILES: readonly ImportCredentialProfile[] = Object.freeze([
  { id: "github", label: "Private GitHub", provider: "github" },
]);

function job(
  state: ImportJob["state"],
  options: {
    readonly progress?: ImportJob["progress"];
  } = {},
): ImportJob {
  const base = {
    id: JOB_ID,
    kind: "project-import" as const,
    state,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...(options.progress === undefined
      ? {}
      : { progress: options.progress }),
  };
  if (state === "completed") {
    return {
      ...base,
      state,
      result: {
        kind: "city-model",
        artifactToken: JOB_ID,
        artifactUrl: `/api/v1/artifacts/${JOB_ID}/city-model.json`,
      },
    };
  }
  if (state === "failed" || state === "cancelled") {
    return {
      ...base,
      state,
      error: {
        code: state === "failed" ? "analysis-failed" : "cancelled",
        message:
          state === "failed"
            ? "Repository analysis failed."
            : "The job was cancelled.",
      },
    };
  }
  return { ...base, state };
}

const RESERVATION: ImportUploadReservation = {
  token: UPLOAD_ID,
  uploadUrl: `/api/v1/imports/uploads/${UPLOAD_ID}`,
  mediaType: "application/json",
  sizeBytes: 2,
  expiresAt: "2026-07-30T10:05:00.000Z",
};

function fakeApi(
  overrides: Partial<ViewerImportApi> = {},
): ViewerImportApi {
  return {
    authorizationStatus: async () => TRUSTED,
    createSession: async () => undefined,
    logout: async () => undefined,
    capabilities: async () => PROFILES,
    createRemoteImport: async () => job("queued"),
    reserveUpload: async () => RESERVATION,
    upload: async () => job("queued"),
    abandonUpload: async () => undefined,
    getJob: async () => job("running"),
    cancelJob: async () => job("cancelled"),
    deleteCompletedJob: async () => undefined,
    ...overrides,
  };
}

class MemoryJobStorage implements ImportJobStorage {
  public value: string | undefined;
  public readonly writes: string[] = [];
  public clearCount = 0;

  public constructor(initial?: string) {
    this.value = initial;
  }

  public read(): string | undefined {
    return this.value;
  }

  public write(id: string): boolean {
    this.value = id;
    this.writes.push(id);
    return true;
  }

  public clear(): void {
    this.value = undefined;
    this.clearCount += 1;
  }
}

function modelGateway(
  responses: Response[] = [
    new Response(JSON.stringify(DEMO_MODEL), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  ],
): ViewerLoadGateway {
  return new ViewerLoadGateway({
    fetch: async () => responses.shift()!,
  });
}

async function settle(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function controllerFixture(options: {
  readonly api?: ViewerImportApi;
  readonly storage?: ImportJobStorage;
  readonly gateway?: ViewerLoadGateway;
}) {
  const states: ImportControllerState[] = [];
  const modelReady = vi.fn();
  const signedOut = vi.fn();
  const scheduled: Array<{
    readonly callback: () => void;
    readonly delay: number;
  }> = [];
  const controller = new ImportController({
    api: options.api ?? fakeApi(),
    storage: options.storage ?? new MemoryJobStorage(),
    loadGateway: options.gateway ?? modelGateway(),
    viewerUrl: VIEWER_URL,
    onStateChange: (state) => {
      states.push(state);
    },
    onModelReady: modelReady,
    onSignedOut: signedOut,
    schedulePoll: (callback, delay) => {
      const entry = { callback, delay };
      scheduled.push(entry);
      return entry;
    },
    clearPoll: (handle) => {
      const index = scheduled.indexOf(
        handle as (typeof scheduled)[number],
      );
      if (index >= 0) scheduled.splice(index, 1);
    },
  });
  return { controller, states, modelReady, signedOut, scheduled };
}

describe("viewer import job storage", () => {
  it("stores only a validated UUID and removes malformed values", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
    };
    const jobs = new LocalImportJobStorage(storage);

    expect(jobs.write(JOB_ID)).toBe(true);
    expect([...values.values()]).toEqual([JOB_ID]);
    expect(jobs.read()).toBe(JOB_ID);
    expect(jobs.write("https://github.com/private/repository")).toBe(
      false,
    );

    values.set("code-city.last-import-job.v1", "not-a-job-id");
    expect(jobs.read()).toBeUndefined();
    expect(values.size).toBe(0);
  });
});

describe("viewer import controller", () => {
  it("exchanges authorization without retaining the token and then becomes ready", async () => {
    const statuses = [UNAUTHENTICATED, AUTHENTICATED];
    const createSession = vi.fn(async (_token: string) => undefined);
    const api = fakeApi({
      authorizationStatus: async () => statuses.shift()!,
      createSession,
    });
    const fixture = controllerFixture({ api });

    fixture.controller.initialize();
    await settle();
    expect(fixture.controller.state).toMatchObject({
      status: "authorization-required",
    });

    fixture.controller.authenticate("one-time-root-token");
    await settle(16);

    expect(createSession).toHaveBeenCalledWith(
      "one-time-root-token",
      expect.any(AbortSignal),
    );
    expect(fixture.controller.state).toMatchObject({
      status: "idle",
      authorization: AUTHENTICATED,
      profiles: PROFILES,
    });
    expect(JSON.stringify(fixture.controller.state)).not.toContain(
      "one-time-root-token",
    );
  });

  it("revokes the browser session, clears recovery state, and cancels a live job", async () => {
    const storage = new MemoryJobStorage(JOB_ID);
    const cancelJob = vi.fn(async () => job("cancelled"));
    const logout = vi.fn(async () => undefined);
    const fixture = controllerFixture({
      storage,
      api: fakeApi({
        authorizationStatus: async () => AUTHENTICATED,
        getJob: async () => job("running"),
        cancelJob,
        logout,
      }),
    });

    fixture.controller.initialize();
    await settle();
    expect(fixture.controller.canSignOut).toBe(true);

    fixture.controller.logout();
    await settle();

    expect(cancelJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(logout).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(storage.value).toBeUndefined();
    expect(fixture.signedOut).toHaveBeenCalledTimes(1);
    expect(fixture.controller.canSignOut).toBe(false);
    expect(fixture.controller.state).toEqual({
      status: "authorization-required",
    });
  });

  it("keeps a failed sign-out visible and retries session revocation", async () => {
    const logout = vi
      .fn<ViewerImportApi["logout"]>()
      .mockRejectedValueOnce(
        new ImportApiError("network", "Could not reach the server."),
      )
      .mockResolvedValueOnce(undefined);
    const fixture = controllerFixture({
      api: fakeApi({
        authorizationStatus: async () => AUTHENTICATED,
        logout,
      }),
    });
    fixture.controller.initialize();
    await settle();

    fixture.controller.logout();
    await settle();
    expect(fixture.controller.state).toEqual({
      status: "sign-out-failed",
      message: "Could not reach the server.",
    });

    fixture.controller.retry();
    await settle();
    expect(logout).toHaveBeenCalledTimes(2);
    expect(fixture.controller.state).toEqual({
      status: "authorization-required",
    });
  });

  it("reissues session revocation on dispose while cleanup is pending", async () => {
    const cancelJob = vi.fn<ViewerImportApi["cancelJob"]>(
      async () =>
        await new Promise<ImportJob>(() => {
          // Deliberately never settles: navigation must not wait for cleanup.
        }),
    );
    const logout = vi.fn(async () => undefined);
    const fixture = controllerFixture({
      storage: new MemoryJobStorage(JOB_ID),
      api: fakeApi({
        authorizationStatus: async () => AUTHENTICATED,
        getJob: async () => job("running"),
        cancelJob,
        logout,
      }),
    });
    fixture.controller.initialize();
    await settle();

    fixture.controller.logout();
    await settle();
    expect(cancelJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(logout).not.toHaveBeenCalled();

    fixture.controller.dispose();
    await settle();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(logout.mock.calls[0]).toEqual([]);
  });

  it("waits for remote acceptance before cancelling and signing out", async () => {
    let resolveRemote: ((value: ImportJob) => void) | undefined;
    let submissionSignal: AbortSignal | undefined;
    const createRemoteImport = vi.fn<ViewerImportApi["createRemoteImport"]>(
      async (_request, signal) => {
        submissionSignal = signal;
        return await new Promise<ImportJob>((resolve) => {
          resolveRemote = resolve;
        });
      },
    );
    const cancelJob = vi.fn(async () => job("cancelled"));
    const logout = vi.fn(async () => undefined);
    const storage = new MemoryJobStorage();
    const fixture = controllerFixture({
      storage,
      api: fakeApi({
        authorizationStatus: async () => AUTHENTICATED,
        createRemoteImport,
        cancelJob,
        logout,
      }),
    });
    fixture.controller.initialize();
    await settle();
    fixture.controller.startRemote({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
    });
    await settle();

    fixture.controller.logout();
    fixture.controller.logout();
    expect(submissionSignal?.aborted).toBe(false);
    expect(fixture.controller.state.status).toBe("signing-out");
    expect(fixture.signedOut).toHaveBeenCalledTimes(1);

    resolveRemote?.(job("queued"));
    await settle(16);
    expect(cancelJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(logout).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(storage.writes).toEqual([]);
    expect(fixture.controller.state.status).toBe(
      "authorization-required",
    );
  });

  it("waits for upload acceptance before cancelling and signing out", async () => {
    let resolveUpload: ((value: ImportJob) => void) | undefined;
    let uploadSignal: AbortSignal | undefined;
    const upload = vi.fn<ViewerImportApi["upload"]>(
      async (_reservation, _body, signal) => {
        uploadSignal = signal;
        return await new Promise<ImportJob>((resolve) => {
          resolveUpload = resolve;
        });
      },
    );
    const abandonUpload = vi.fn(async () => undefined);
    const cancelJob = vi.fn(async () => job("cancelled"));
    const logout = vi.fn(async () => undefined);
    const storage = new MemoryJobStorage();
    const fixture = controllerFixture({
      storage,
      api: fakeApi({
        authorizationStatus: async () => AUTHENTICATED,
        upload,
        abandonUpload,
        cancelJob,
        logout,
      }),
    });
    fixture.controller.initialize();
    await settle();
    fixture.controller.startUpload(
      { source: { kind: "city-model", sizeBytes: 2 } },
      new Blob(["{}"]),
    );
    await settle();

    fixture.controller.logout();
    expect(uploadSignal?.aborted).toBe(false);
    expect(fixture.controller.state.status).toBe("signing-out");

    resolveUpload?.(job("queued"));
    await settle(16);
    expect(cancelJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(abandonUpload).not.toHaveBeenCalled();
    expect(logout).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(storage.writes).toEqual([]);
    expect(fixture.controller.state.status).toBe(
      "authorization-required",
    );
  });

  it("abandons a reservation that arrives while signing out", async () => {
    let resolveReservation:
      | ((reservation: ImportUploadReservation) => void)
      | undefined;
    let reservationSignal: AbortSignal | undefined;
    const reserveUpload = vi.fn<ViewerImportApi["reserveUpload"]>(
      async (_request, signal) => {
        reservationSignal = signal;
        return await new Promise<ImportUploadReservation>((resolve) => {
          resolveReservation = resolve;
        });
      },
    );
    const upload = vi.fn(async () => job("queued"));
    const abandonUpload = vi.fn(async () => undefined);
    const logout = vi.fn(async () => undefined);
    const fixture = controllerFixture({
      api: fakeApi({
        authorizationStatus: async () => AUTHENTICATED,
        reserveUpload,
        upload,
        abandonUpload,
        logout,
      }),
    });
    fixture.controller.initialize();
    await settle();
    fixture.controller.startUpload(
      { source: { kind: "city-model", sizeBytes: 2 } },
      new Blob(["{}"]),
    );
    await settle();

    fixture.controller.logout();
    expect(reservationSignal?.aborted).toBe(false);
    resolveReservation?.(RESERVATION);
    await settle(16);

    expect(upload).not.toHaveBeenCalled();
    expect(abandonUpload).toHaveBeenCalledWith(
      RESERVATION,
      expect.any(AbortSignal),
    );
    expect(logout).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(fixture.controller.state.status).toBe(
      "authorization-required",
    );
  });

  it("persists, polls, validates, and automatically opens a completed import", async () => {
    const storage = new MemoryJobStorage();
    const getJob = vi
      .fn<ViewerImportApi["getJob"]>()
      .mockResolvedValueOnce(
        job("running", {
          progress: {
            phase: "analyzing-repository",
            current: 1,
            total: 3,
          },
        }),
      )
      .mockResolvedValueOnce(job("completed"));
    const fixture = controllerFixture({
      storage,
      api: fakeApi({ getJob }),
    });
    fixture.controller.initialize();
    await settle();
    fixture.controller.startRemote({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
    });
    await settle();

    expect(storage.value).toBe(JOB_ID);
    expect(fixture.controller.state).toMatchObject({
      status: "job",
      job: { state: "queued" },
    });
    expect(fixture.scheduled).toHaveLength(1);

    fixture.scheduled.shift()!.callback();
    await settle();
    expect(fixture.controller.state).toMatchObject({
      status: "job",
      job: {
        state: "running",
        progress: { phase: "analyzing-repository" },
      },
    });

    fixture.scheduled.shift()!.callback();
    await settle(16);
    expect(fixture.modelReady).toHaveBeenCalledTimes(1);
    expect(fixture.modelReady.mock.calls[0]![0]).toEqual(DEMO_MODEL);
    expect(fixture.modelReady.mock.calls[0]![1]).toMatchObject({
      label: "Imported project",
      jobId: JOB_ID,
    });
    expect(fixture.controller.state).toMatchObject({
      status: "completed",
      job: { id: JOB_ID, state: "completed" },
    });
    expect(storage.writes.every((value) => value === JOB_ID)).toBe(true);
  });

  it("locks cancellation while a completed artifact is opening", async () => {
    let resolveArtifact: ((response: Response) => void) | undefined;
    const gateway = new ViewerLoadGateway({
      fetch: async () =>
        await new Promise<Response>((resolve) => {
          resolveArtifact = resolve;
        }),
    });
    const fixture = controllerFixture({
      storage: new MemoryJobStorage(JOB_ID),
      api: fakeApi({ getJob: async () => job("completed") }),
      gateway,
    });

    fixture.controller.initialize();
    await settle();
    expect(fixture.controller.state).toMatchObject({
      status: "opening-artifact",
      job: { state: "completed" },
    });

    fixture.controller.cancel();
    expect(fixture.controller.state.status).toBe("opening-artifact");

    resolveArtifact?.(
      new Response(JSON.stringify(DEMO_MODEL), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    await settle(16);
    expect(fixture.controller.state.status).toBe("completed");
    expect(fixture.modelReady).toHaveBeenCalledTimes(1);
  });

  it("recovers a persisted completed job after refresh", async () => {
    const storage = new MemoryJobStorage(JOB_ID);
    const getJob = vi.fn(async () => job("completed"));
    const fixture = controllerFixture({
      storage,
      api: fakeApi({ getJob }),
    });

    fixture.controller.initialize();
    await settle(16);

    expect(getJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(fixture.modelReady).toHaveBeenCalledTimes(1);
    expect(fixture.controller.state.status).toBe("completed");
  });

  it("removes a completed saved import and clears recovery state", async () => {
    const storage = new MemoryJobStorage(JOB_ID);
    let finishDeletion!: () => void;
    const deletion = new Promise<void>((resolve) => {
      finishDeletion = resolve;
    });
    const deleteCompletedJob = vi.fn(async () => deletion);
    const fixture = controllerFixture({
      storage,
      api: fakeApi({
        getJob: async () => job("completed"),
        deleteCompletedJob,
      }),
    });
    fixture.controller.initialize();
    await settle(16);
    expect(fixture.controller.state.status).toBe("completed");

    fixture.controller.removeCompleted();
    expect(fixture.controller.state).toMatchObject({
      status: "removing-completed",
      job: { id: JOB_ID, state: "completed" },
    });
    expect(storage.value).toBe(JOB_ID);
    finishDeletion();
    await settle();

    expect(deleteCompletedJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(storage.value).toBeUndefined();
    expect(fixture.controller.state.status).toBe("idle");
  });

  it("retains a completed job after deletion failure and retries safely", async () => {
    const storage = new MemoryJobStorage(JOB_ID);
    const deleteCompletedJob = vi
      .fn<ViewerImportApi["deleteCompletedJob"]>()
      .mockRejectedValueOnce(
        new ImportApiError("network", "Removal is temporarily unavailable."),
      )
      .mockResolvedValueOnce(undefined);
    const fixture = controllerFixture({
      storage,
      api: fakeApi({
        getJob: async () => job("completed"),
        deleteCompletedJob,
      }),
    });
    fixture.controller.initialize();
    await settle(16);

    fixture.controller.removeCompleted();
    await settle();
    expect(fixture.controller.state).toMatchObject({
      status: "removal-failed",
      job: { id: JOB_ID },
      message: "Removal is temporarily unavailable.",
    });
    expect(storage.value).toBe(JOB_ID);

    fixture.controller.removeCompleted();
    await settle();
    expect(deleteCompletedJob).toHaveBeenCalledTimes(2);
    expect(storage.value).toBeUndefined();
    expect(fixture.controller.state.status).toBe("idle");
  });

  it("treats an already missing completed job as a successful removal", async () => {
    const storage = new MemoryJobStorage(JOB_ID);
    const fixture = controllerFixture({
      storage,
      api: fakeApi({
        getJob: async () => job("completed"),
        deleteCompletedJob: async () => {
          throw new ImportApiError("http", "Job not found.", {
            status: 404,
            code: "job-not-found",
          });
        },
      }),
    });
    fixture.controller.initialize();
    await settle(16);

    fixture.controller.removeCompleted();
    await settle();
    expect(storage.value).toBeUndefined();
    expect(fixture.controller.state.status).toBe("idle");
  });

  it("keeps a saved job through authorization expiry and resumes after login", async () => {
    const storage = new MemoryJobStorage(JOB_ID);
    const statuses = [UNAUTHENTICATED, AUTHENTICATED];
    const getJob = vi.fn(async () => job("completed"));
    const fixture = controllerFixture({
      storage,
      api: fakeApi({
        authorizationStatus: async () => statuses.shift()!,
        getJob,
      }),
    });

    fixture.controller.initialize();
    await settle();
    expect(fixture.controller.state).toMatchObject({
      status: "authorization-required",
      resumeJobId: JOB_ID,
    });
    expect(storage.value).toBe(JOB_ID);

    fixture.controller.authenticate("replacement-token");
    await settle(16);
    expect(getJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(fixture.controller.state.status).toBe("completed");
  });

  it("recovers transient polling failures without overlapping requests", async () => {
    let resolveGet: ((value: ImportJob) => void) | undefined;
    const getJob = vi
      .fn<ViewerImportApi["getJob"]>()
      .mockRejectedValueOnce(
        new ImportApiError("network", "Temporary network failure."),
      )
      .mockImplementationOnce(
        async () =>
          await new Promise<ImportJob>((resolve) => {
            resolveGet = resolve;
          }),
      );
    const fixture = controllerFixture({
      storage: new MemoryJobStorage(JOB_ID),
      api: fakeApi({ getJob }),
    });
    fixture.controller.initialize();
    await settle();

    expect(fixture.controller.state).toMatchObject({
      status: "recovering",
      jobId: JOB_ID,
    });
    expect(fixture.scheduled).toHaveLength(1);
    fixture.scheduled.shift()!.callback();
    await settle();
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(fixture.scheduled).toHaveLength(0);

    resolveGet?.(job("running"));
    await settle();
    expect(fixture.controller.state).toMatchObject({
      status: "job",
      job: { state: "running" },
    });
    expect(fixture.scheduled).toHaveLength(1);
  });

  it("cancels server jobs explicitly but never cancels them during dispose", async () => {
    const cancelJob = vi.fn(async () => job("cancelled"));
    const api = fakeApi({ cancelJob });
    const first = controllerFixture({ api });
    first.controller.initialize();
    await settle();
    first.controller.startRemote({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
    });
    await settle();
    first.controller.cancel();
    await settle();

    expect(cancelJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(first.controller.state).toMatchObject({
      status: "terminal",
      job: { state: "cancelled" },
    });

    const secondCancel = vi.fn(async () => job("cancelled"));
    const second = controllerFixture({
      api: fakeApi({ cancelJob: secondCancel }),
    });
    second.controller.initialize();
    await settle();
    second.controller.startRemote({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
    });
    await settle();
    second.controller.dispose();
    second.scheduled.shift()?.callback();
    await settle();
    expect(secondCancel).not.toHaveBeenCalled();
  });

  it("reissues cancellation after a transient delete failure", async () => {
    const cancelJob = vi
      .fn<ViewerImportApi["cancelJob"]>()
      .mockRejectedValueOnce(
        new ImportApiError("network", "Cancellation timed out."),
      )
      .mockResolvedValueOnce(job("cancelled"));
    const getJob = vi.fn(async () => job("running"));
    const fixture = controllerFixture({
      api: fakeApi({ cancelJob, getJob }),
    });
    fixture.controller.initialize();
    await settle();
    fixture.controller.startRemote({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
    });
    await settle();

    fixture.controller.cancel();
    await settle();
    expect(fixture.controller.state).toMatchObject({
      status: "recovering",
      jobId: JOB_ID,
    });
    expect(fixture.scheduled).toHaveLength(1);

    fixture.scheduled.shift()!.callback();
    await settle(16);
    expect(getJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(cancelJob).toHaveBeenCalledTimes(2);
    expect(fixture.controller.state).toMatchObject({
      status: "terminal",
      job: { state: "cancelled" },
    });
  });

  it("reissues cancellation after authorization is restored", async () => {
    const cancelJob = vi
      .fn<ViewerImportApi["cancelJob"]>()
      .mockRejectedValueOnce(
        new ImportApiError("http", "Sign in again.", { status: 401 }),
      )
      .mockResolvedValueOnce(job("cancelled"));
    const getJob = vi.fn(async () => job("running"));
    const fixture = controllerFixture({
      api: fakeApi({
        authorizationStatus: async () => AUTHENTICATED,
        cancelJob,
        getJob,
      }),
    });
    fixture.controller.initialize();
    await settle();
    fixture.controller.startRemote({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
    });
    await settle();

    fixture.controller.cancel();
    await settle();
    expect(fixture.controller.state).toMatchObject({
      status: "authorization-required",
      resumeJobId: JOB_ID,
    });

    fixture.controller.authenticate("replacement-token");
    await settle(24);
    expect(getJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(cancelJob).toHaveBeenCalledTimes(2);
    expect(fixture.controller.state).toMatchObject({
      status: "terminal",
      job: { state: "cancelled" },
    });
  });

  it("waits for remote acceptance and cancels the returned job", async () => {
    let resolveRemote: ((value: ImportJob) => void) | undefined;
    let submissionSignal: AbortSignal | undefined;
    const createRemoteImport = vi.fn<ViewerImportApi["createRemoteImport"]>(
      async (_request, signal) => {
        submissionSignal = signal;
        return await new Promise<ImportJob>((resolve) => {
          resolveRemote = resolve;
        });
      },
    );
    const cancelJob = vi.fn(async () => job("cancelled"));
    const storage = new MemoryJobStorage();
    const fixture = controllerFixture({
      storage,
      api: fakeApi({ createRemoteImport, cancelJob }),
    });
    fixture.controller.initialize();
    await settle();
    fixture.controller.startRemote({
      source: {
        kind: "github",
        repositoryUrl: "https://github.com/openai/example",
      },
    });
    await settle();

    fixture.controller.cancel();

    expect(submissionSignal?.aborted).toBe(false);
    expect(fixture.controller.state).toMatchObject({
      status: "preparing",
      phase: "submitting-import",
      cancelling: true,
    });
    expect(cancelJob).not.toHaveBeenCalled();

    resolveRemote?.(job("queued"));
    await settle();

    expect(storage.value).toBe(JOB_ID);
    expect(cancelJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(fixture.controller.state).toMatchObject({
      status: "terminal",
      job: { state: "cancelled" },
    });
  });

  it("abandons a reservation that arrives after local upload cancellation", async () => {
    let resolveReservation:
      | ((reservation: ImportUploadReservation) => void)
      | undefined;
    let reservationSignal: AbortSignal | undefined;
    const reserveUpload = vi.fn<ViewerImportApi["reserveUpload"]>(
      async (_request, signal) => {
        reservationSignal = signal;
        return await new Promise<ImportUploadReservation>((resolve) => {
          resolveReservation = resolve;
        });
      },
    );
    const abandonUpload = vi.fn(async () => undefined);
    const upload = vi.fn(async () => job("queued"));
    const fixture = controllerFixture({
      api: fakeApi({ reserveUpload, abandonUpload, upload }),
    });
    fixture.controller.initialize();
    await settle();
    fixture.controller.startUpload(
      { source: { kind: "city-model", sizeBytes: 2 } },
      new Blob(["{}"]),
    );
    await settle();

    fixture.controller.cancel();

    expect(reservationSignal?.aborted).toBe(false);
    expect(fixture.controller.state).toMatchObject({
      status: "preparing",
      phase: "reserving-upload",
      cancelling: true,
    });
    resolveReservation?.(RESERVATION);
    await settle();

    expect(upload).not.toHaveBeenCalled();
    expect(abandonUpload).toHaveBeenCalledWith(RESERVATION);
    expect(fixture.controller.state.status).toBe("idle");
  });

  it("waits for upload acceptance and cancels the returned job", async () => {
    let resolveUpload: ((value: ImportJob) => void) | undefined;
    let uploadSignal: AbortSignal | undefined;
    const upload = vi.fn<ViewerImportApi["upload"]>(
      async (_reservation, _body, signal) => {
        uploadSignal = signal;
        return await new Promise<ImportJob>((resolve) => {
          resolveUpload = resolve;
        });
      },
    );
    const abandonUpload = vi.fn(async () => undefined);
    const cancelJob = vi.fn(async () => job("cancelled"));
    const storage = new MemoryJobStorage();
    const fixture = controllerFixture({
      storage,
      api: fakeApi({ upload, abandonUpload, cancelJob }),
    });
    fixture.controller.initialize();
    await settle();
    fixture.controller.startUpload(
      { source: { kind: "city-model", sizeBytes: 2 } },
      new Blob(["{}"]),
    );
    await settle();
    expect(fixture.controller.state).toMatchObject({
      status: "preparing",
      phase: "uploading",
      cancelling: false,
    });

    fixture.controller.cancel();

    expect(uploadSignal?.aborted).toBe(false);
    expect(fixture.controller.state).toMatchObject({
      status: "preparing",
      phase: "uploading",
      cancelling: true,
    });
    expect(abandonUpload).not.toHaveBeenCalled();
    expect(cancelJob).not.toHaveBeenCalled();

    resolveUpload?.(job("queued"));
    await settle();

    expect(storage.value).toBe(JOB_ID);
    expect(cancelJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.any(AbortSignal),
    );
    expect(abandonUpload).not.toHaveBeenCalled();
    expect(fixture.controller.state).toMatchObject({
      status: "terminal",
      job: { state: "cancelled" },
    });
  });

  it("retains a completed job when artifact loading fails and retries safely", async () => {
    const responses = [
      new Response(
        JSON.stringify({
          error: { code: "artifact-busy", message: "Busy." },
        }),
        {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
      new Response(JSON.stringify(DEMO_MODEL), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    ];
    const fixture = controllerFixture({
      storage: new MemoryJobStorage(JOB_ID),
      api: fakeApi({ getJob: async () => job("completed") }),
      gateway: modelGateway(responses),
    });
    fixture.controller.initialize();
    await settle(16);

    expect(fixture.controller.state).toMatchObject({
      status: "artifact-failed",
      job: { state: "completed" },
    });
    fixture.controller.retry();
    await settle(16);
    expect(fixture.modelReady).toHaveBeenCalledTimes(1);
    expect(fixture.controller.state.status).toBe("completed");
  });
});
