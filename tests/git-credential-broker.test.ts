import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGenericGitCredentialBroker,
  gitCredentialHelperCommand,
  quoteGitCredentialHelperArgument,
  type GenericGitCredentialBrokerFactory,
  type GenericGitCredentialBrokerRequest,
} from "../packages/analyzer/src/git-credential-broker.js";
import {
  snapshotGenericGitRepository,
  type GenericGitSnapshotCredential,
  type GenericGitSnapshotCredentialProvider,
  type GenericGitSnapshotDependencies,
  type GenericGitTemporaryWorkspace,
  type GitProcessRequest,
} from "../packages/analyzer/src/git-snapshot.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const encoder = new TextEncoder();
const temporaryRoots: string[] = [];

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function operationOf(request: GitProcessRequest): string {
  return (
    request.arguments.find((argument) =>
      [
        "archive",
        "fetch",
        "init",
        "ls-remote",
        "rev-parse",
      ].includes(argument),
    ) ?? ""
  );
}

function archiveOutputPath(
  arguments_: readonly string[],
): string | undefined {
  const joined = arguments_.find((argument) =>
    argument.startsWith("--output="),
  );
  if (joined !== undefined) return joined.slice("--output=".length);
  const index = arguments_.indexOf("--output");
  return index < 0 ? undefined : arguments_[index + 1];
}

interface SnapshotHarness {
  readonly dependencies: GenericGitSnapshotDependencies;
  readonly calls: GitProcessRequest[];
  readonly dispose: ReturnType<typeof vi.fn>;
}

async function snapshotHarness(
  onGit?: (request: GitProcessRequest) => Promise<void> | void,
): Promise<SnapshotHarness> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-credential-snapshot-"),
  );
  temporaryRoots.push(root);
  const repositoryDirectory = path.join(root, "repository.git");
  const templateDirectory = path.join(root, "empty-template");
  await fs.mkdir(repositoryDirectory);
  await fs.mkdir(templateDirectory);
  const dispose = vi.fn(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace: GenericGitTemporaryWorkspace = {
    root,
    repositoryDirectory,
    templateDirectory,
    measureBytes: async () => 4_096,
    dispose,
  };
  const calls: GitProcessRequest[] = [];
  const runGit: NonNullable<
    GenericGitSnapshotDependencies["runGit"]
  > = async (request) => {
    calls.push(request);
    await onGit?.(request);
    const operation = operationOf(request);
    if (operation === "ls-remote") {
      return {
        exitCode: 0,
        stdout: bytes(
          `ref: refs/heads/main\tHEAD\n${COMMIT}\tHEAD\n`,
        ),
      };
    }
    if (operation === "rev-parse") {
      return {
        exitCode: 0,
        stdout: bytes(`${COMMIT}\n`),
      };
    }
    if (operation === "archive") {
      const output = archiveOutputPath(request.arguments);
      if (output === undefined) throw new Error("missing archive output");
      await fs.writeFile(
        output,
        zipSync({
          "snapshot/src/main.ts": strToU8(
            "export const answer = 42;\n",
          ),
        }),
      );
    }
    return { exitCode: 0, stdout: new Uint8Array() };
  };
  return {
    dependencies: {
      runGit,
      createTemporaryWorkspace: async () => workspace,
    },
    calls,
    dispose,
  };
}

function providerFor(
  secretText: string,
  events: string[] = [],
): {
  readonly provider: GenericGitSnapshotCredentialProvider;
  readonly issued: Uint8Array[];
  readonly uses: () => number;
} {
  const issued: Uint8Array[] = [];
  let useCount = 0;
  return {
    provider: {
      provider: "basic",
      async use<T>(
        signal: AbortSignal,
        operation: (
          credential: {
            readonly kind: "basic";
            readonly username: string;
            readonly secret: Uint8Array;
          },
        ) => T | Promise<T>,
      ): Promise<T> {
        signal.throwIfAborted();
        useCount += 1;
        const secret = bytes(secretText);
        issued.push(secret);
        events.push("provider:start");
        try {
          return await operation({
            kind: "basic",
            username: "profile-user-137",
            secret,
          });
        } finally {
          secret.fill(0);
          events.push("provider:end");
        }
      },
    },
    issued,
    uses: () => useCount,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Generic Git selected credential integration", () => {
  it("uses three fresh one-shot brokers and isolates every selected Git process", async () => {
    const events: string[] = [];
    const harness = await snapshotHarness(async (request) => {
      const operation = operationOf(request);
      events.push(`git:${operation}`);
      expect(request.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
      const globalConfig = request.env["GIT_CONFIG_GLOBAL"];
      expect(globalConfig).toBeDefined();
      expect(await fs.readFile(globalConfig!, "utf8")).toBe("");
    });
    const credentials = providerFor(
      "selected-secret-\u00e4=",
      events,
    );
    const brokerRequests: GenericGitCredentialBrokerRequest[] = [];
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const createCredentialBroker: GenericGitCredentialBrokerFactory =
      vi.fn(async (request) => {
        const index = brokerRequests.length;
        brokerRequests.push(request);
        events.push(`broker:${index}:start`);
        const dispose = vi.fn(async () => {
          events.push(`broker:${index}:dispose`);
        });
        disposals.push(dispose);
        return {
          helperCommand:
            `!'trusted-dotnet' 'trusted.dll' helper 'pipe-${index}'`,
          dispose,
        };
      });

    await snapshotGenericGitRepository(
      {
        repositoryUrl:
          "https://dev.azure.example:8443/Collection/Project/_git/Repo%20Name.git",
      },
      {
        ...harness.dependencies,
        environment: {
          PATH: "C:\\trusted-bin",
          HOME: "C:\\ambient-home",
          USERPROFILE: "C:\\ambient-profile",
          XDG_CONFIG_HOME: "C:\\ambient-xdg",
          APPDATA: "C:\\ambient-app-data",
          LOCALAPPDATA: "C:\\ambient-local-data",
          SSH_AUTH_SOCK: "ambient-agent",
          HTTPS_PROXY: "https://proxy.example:8443",
          SSL_CERT_FILE: "C:\\trusted-ca.pem",
        },
        credentialProvider: credentials.provider,
        createCredentialBroker,
      },
    );

    expect(credentials.uses()).toBe(3);
    expect(createCredentialBroker).toHaveBeenCalledTimes(3);
    expect(disposals).toHaveLength(3);
    for (const dispose of disposals) {
      expect(dispose).toHaveBeenCalledOnce();
    }
    expect(
      brokerRequests.map(({ host, path: credentialPath, username }) => ({
        host,
        path: credentialPath,
        username,
      })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        host: "dev.azure.example:8443",
        path: "Collection/Project/_git/Repo Name.git",
        username: "profile-user-137",
      })),
    );
    for (const request of brokerRequests) {
      expect([...request.secret]).toEqual(
        Array(request.secret.byteLength).fill(0),
      );
    }
    for (const secret of credentials.issued) {
      expect([...secret]).toEqual(
        Array(secret.byteLength).fill(0),
      );
    }

    const remoteCalls = harness.calls.filter((request) =>
      ["fetch", "ls-remote"].includes(operationOf(request)),
    );
    const localCalls = harness.calls.filter((request) =>
      ["archive", "init", "rev-parse"].includes(
        operationOf(request),
      ),
    );
    expect(remoteCalls).toHaveLength(3);
    for (const request of remoteCalls) {
      expect(request.arguments).toContain("credential.helper=");
      expect(request.arguments).toContain(
        "credential.useHttpPath=true",
      );
      expect(request.arguments).toContain(
        "credential.protectProtocol=true",
      );
      expect(request.arguments).toContain("http.extraHeader=");
      expect(request.arguments).toContain("http.cookieFile=");
      expect(request.arguments).toContain("core.askPass=");
      expect(
        request.arguments.some((argument) =>
          argument.startsWith("credential.helper=!"),
        ),
      ).toBe(true);
    }
    for (const request of localCalls) {
      expect(request.arguments).toContain("credential.helper=");
      expect(request.arguments).toContain("http.extraHeader=");
      expect(request.arguments).toContain("http.cookieFile=");
      expect(request.arguments).toContain("core.askPass=");
      expect(
        request.arguments.some((argument) =>
          argument.startsWith("credential.helper=!"),
        ),
      ).toBe(false);
    }
    for (const request of harness.calls) {
      expect(request.env["HOME"]).not.toBe("C:\\ambient-home");
      expect(request.env["USERPROFILE"]).not.toBe(
        "C:\\ambient-profile",
      );
      expect(request.env["XDG_CONFIG_HOME"]).not.toBe(
        "C:\\ambient-xdg",
      );
      expect(request.env["APPDATA"]).not.toBe(
        "C:\\ambient-app-data",
      );
      expect(request.env["LOCALAPPDATA"]).not.toBe(
        "C:\\ambient-local-data",
      );
      expect(request.env["SSH_AUTH_SOCK"]).toBeUndefined();
      expect(request.env["HTTPS_PROXY"]).toBe(
        "https://proxy.example:8443",
      );
      expect(request.env["SSL_CERT_FILE"]).toBe(
        "C:\\trusted-ca.pem",
      );
      const serialized = JSON.stringify({
        arguments: request.arguments,
        environment: request.env,
      });
      expect(serialized).not.toContain("profile-user-137");
      expect(serialized).not.toContain("selected-secret-\u00e4=");
    }
    expect(events).toEqual([
      "provider:start",
      "broker:0:start",
      "git:ls-remote",
      "broker:0:dispose",
      "provider:end",
      "git:init",
      "provider:start",
      "broker:1:start",
      "git:fetch",
      "broker:1:dispose",
      "provider:end",
      "git:rev-parse",
      "provider:start",
      "broker:2:start",
      "git:ls-remote",
      "broker:2:dispose",
      "provider:end",
      "git:archive",
    ]);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "standard HTTPS authority",
      "https://example.com/repo.git",
      "example.com",
      "repo.git",
    ],
    [
      "non-default port and decoded edge spaces",
      "https://example.com:8443/a/%20Repo%20.git",
      "example.com:8443",
      "a/ Repo .git",
    ],
    [
      "Azure DevOps path",
      "https://dev.azure.com/Org/Project/_git/Repo",
      "dev.azure.com",
      "Org/Project/_git/Repo",
    ],
  ] as const)(
    "derives exact helper context for %s",
    async (_label, repositoryUrl, expectedHost, expectedPath) => {
      const harness = await snapshotHarness();
      const credentials = providerFor("path-shape-secret");
      const targets: Array<{
        readonly host: string;
        readonly path: string;
      }> = [];

      await snapshotGenericGitRepository(
        { repositoryUrl },
        {
          ...harness.dependencies,
          credentialProvider: credentials.provider,
          createCredentialBroker: async (request) => {
            targets.push({
              host: request.host,
              path: request.path,
            });
            return {
              helperCommand: "!'trusted-helper' helper 'pipe'",
              dispose: async () => undefined,
            };
          },
        },
      );

      expect(targets).toEqual(
        Array.from({ length: 3 }, () => ({
          host: expectedHost,
          path: expectedPath,
        })),
      );
    },
  );

  it.each([
    "https://example.com:443/Org/Repo.git",
    "https://EXAMPLE.com/Org/Repo.git",
    "https://example.com/Org/./Repo.git",
    "https://example.com/Org/%2E%2E/Repo.git",
    "https://example.com/Org/Repo Name.git",
    "https://example.com/Org//Repo.git",
    "https://example.com/Org%2FProject/Repo.git",
  ])(
    "rejects noncanonical selected URL syntax before the workspace: %s",
    async (repositoryUrl) => {
      const harness = await snapshotHarness();
      const credentials = providerFor("noncanonical-secret");
      const createCredentialBroker = vi.fn<
        GenericGitCredentialBrokerFactory
      >();

      await expect(
        snapshotGenericGitRepository(
          { repositoryUrl },
          {
            ...harness.dependencies,
            credentialProvider: credentials.provider,
            createCredentialBroker,
          },
        ),
      ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });

      expect(credentials.uses()).toBe(0);
      expect(createCredentialBroker).not.toHaveBeenCalled();
      expect(harness.dispose).not.toHaveBeenCalled();
    },
  );

  it("does not alter anonymous HTTPS behavior or create a broker", async () => {
    const harness = await snapshotHarness();
    const createCredentialBroker = vi.fn<
      GenericGitCredentialBrokerFactory
    >();

    await snapshotGenericGitRepository(
      { repositoryUrl: "https://example.com/repo.git" },
      {
        ...harness.dependencies,
        environment: {
          HOME: "C:\\ambient-home",
          SSH_AUTH_SOCK: "ambient-agent",
        },
        createCredentialBroker,
      },
    );

    expect(createCredentialBroker).not.toHaveBeenCalled();
    for (const request of harness.calls) {
      expect(request.env["HOME"]).toBe("C:\\ambient-home");
      expect(request.env["SSH_AUTH_SOCK"]).toBe(
        "ambient-agent",
      );
      expect(request.env["GIT_CONFIG_NOSYSTEM"]).toBeUndefined();
      expect(request.arguments).not.toContain("credential.helper=");
    }
  });

  it.each([
    {
      label: "SSH transport",
      repositoryUrl: "ssh://git@example.com/Org/Repo.git",
      provider: {
        provider: "basic",
        use: vi.fn(),
      },
    },
    {
      label: "wrong provider discriminator",
      repositoryUrl: "https://example.com/Org/Repo.git",
      provider: {
        provider: "github",
        use: vi.fn(),
      },
    },
  ])(
    "rejects $label before using credentials or a workspace",
    async ({ repositoryUrl, provider }) => {
      const harness = await snapshotHarness();
      const createCredentialBroker = vi.fn<
        GenericGitCredentialBrokerFactory
      >();

      await expect(
        snapshotGenericGitRepository(
          { repositoryUrl },
          {
            ...harness.dependencies,
            credentialProvider:
              provider as unknown as GenericGitSnapshotCredentialProvider,
            createCredentialBroker,
          },
        ),
      ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });

      expect(provider.use).not.toHaveBeenCalled();
      expect(createCredentialBroker).not.toHaveBeenCalled();
      expect(harness.dispose).not.toHaveBeenCalled();
    },
  );

  it("rejects unsafe material before creating a broker", async () => {
    const harness = await snapshotHarness();
    const createCredentialBroker = vi.fn<
      GenericGitCredentialBrokerFactory
    >();
    const provider: GenericGitSnapshotCredentialProvider = {
      provider: "basic",
      use: async (_signal, operation) =>
        operation({
          kind: "basic",
          username: "safe-user",
          secret: new Uint8Array([0xff]),
        }),
    };

    await expect(
      snapshotGenericGitRepository(
        { repositoryUrl: "https://example.com/Org/Repo.git" },
        {
          ...harness.dependencies,
          credentialProvider: provider,
          createCredentialBroker,
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });

    expect(createCredentialBroker).not.toHaveBeenCalled();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("disposes the broker and zeros its copy on cancellation", async () => {
    const controller = new AbortController();
    const credentials = providerFor("cancel-secret-137");
    let captured: GenericGitCredentialBrokerRequest | undefined;
    const dispose = vi.fn(async () => undefined);
    const harness = await snapshotHarness(
      (request) =>
        new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("runner cancelled")),
            { once: true },
          );
          globalThis.setTimeout(() => controller.abort(), 10);
        }),
    );

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl: "https://example.com/Org/Repo.git",
          signal: controller.signal,
          timeoutMs: 1_000,
        },
        {
          ...harness.dependencies,
          credentialProvider: credentials.provider,
          createCredentialBroker: async (request) => {
            captured = request;
            return {
              helperCommand: "!'trusted-helper' helper 'pipe'",
              dispose,
            };
          },
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_ABORTED" });

    expect(dispose).toHaveBeenCalledOnce();
    expect(captured).toBeDefined();
    expect([...(captured?.secret ?? [])]).toEqual(
      Array(captured?.secret.byteLength ?? 0).fill(0),
    );
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("returns promptly and zeros material when a broker factory never settles", async () => {
    const controller = new AbortController();
    const credentials = providerFor("nonsettling-secret-137");
    const harness = await snapshotHarness();
    let captured: GenericGitCredentialBrokerRequest | undefined;
    const started = Date.now();

    await expect(
      snapshotGenericGitRepository(
        {
          repositoryUrl: "https://example.com/Org/Repo.git",
          signal: controller.signal,
          timeoutMs: 1_000,
        },
        {
          ...harness.dependencies,
          credentialProvider: credentials.provider,
          createCredentialBroker: (request) => {
            captured = request;
            controller.abort();
            return new Promise(() => undefined);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_ABORTED" });

    expect(Date.now() - started).toBeLessThan(500);
    expect(captured).toBeDefined();
    expect([...(captured?.secret ?? [])]).toEqual(
      Array(captured?.secret.byteLength ?? 0).fill(0),
    );
    expect(harness.calls).toHaveLength(0);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("aborts and awaits cleanup when a provider invokes its callback twice", async () => {
    const harness = await snapshotHarness();
    const brokerRequests: GenericGitCredentialBrokerRequest[] = [];
    const dispose = vi.fn(async () => undefined);
    const originalSecrets: Uint8Array[] = [];
    const unhandledReasons: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    const provider: GenericGitSnapshotCredentialProvider = {
      provider: "basic",
      async use<T>(
        _signal: AbortSignal,
        operation: (
          credential: GenericGitSnapshotCredential,
        ) => T | Promise<T>,
      ): Promise<T> {
        const firstSecret = bytes("first-double-secret");
        const secondSecret = bytes("second-double-secret");
        originalSecrets.push(firstSecret, secondSecret);
        try {
          const first = Promise.resolve(
            operation({
              kind: "basic",
              username: "safe-user",
              secret: firstSecret,
            }),
          );
          void operation({
            kind: "basic",
            username: "safe-user",
            secret: secondSecret,
          });
          return await first;
        } finally {
          firstSecret.fill(0);
          secondSecret.fill(0);
        }
      },
    };

    process.on("unhandledRejection", recordUnhandled);
    try {
      await expect(
        snapshotGenericGitRepository(
          { repositoryUrl: "https://example.com/Org/Repo.git" },
          {
            ...harness.dependencies,
            credentialProvider: provider,
            createCredentialBroker: async (request) => {
              brokerRequests.push(request);
              return {
                helperCommand: "!'trusted-helper' helper 'pipe'",
                dispose,
              };
            },
          },
        ),
      ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }

    expect(unhandledReasons).toEqual([]);
    expect(brokerRequests).toHaveLength(1);
    expect(dispose).toHaveBeenCalledOnce();
    expect([...brokerRequests[0]!.secret]).toEqual(
      Array(brokerRequests[0]!.secret.byteLength).fill(0),
    );
    for (const secret of originalSecrets) {
      expect([...secret]).toEqual(
        Array(secret.byteLength).fill(0),
      );
    }
    expect(harness.calls).toHaveLength(0);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a provider that returns before its first callback and blocks the late callback", async () => {
    const harness = await snapshotHarness();
    const createCredentialBroker = vi.fn<
      GenericGitCredentialBrokerFactory
    >();
    let finishLate!: () => void;
    const lateFinished = new Promise<void>((resolve) => {
      finishLate = resolve;
    });
    const provider: GenericGitSnapshotCredentialProvider = {
      provider: "basic",
      use<T>(
        _signal: AbortSignal,
        operation: (
          credential: GenericGitSnapshotCredential,
        ) => T | Promise<T>,
      ): Promise<T> {
        globalThis.setTimeout(() => {
          const secret = bytes("return-before-secret");
          void Promise.resolve(
            operation({
              kind: "basic",
              username: "safe-user",
              secret,
            }),
          )
            .catch(() => undefined)
            .finally(() => {
              secret.fill(0);
              finishLate();
            });
        }, 10);
        return Promise.resolve(undefined as T);
      },
    };

    await expect(
      snapshotGenericGitRepository(
        { repositoryUrl: "https://example.com/Org/Repo.git" },
        {
          ...harness.dependencies,
          credentialProvider: provider,
          createCredentialBroker,
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_INVALID_REQUEST" });
    await lateFinished;

    expect(createCredentialBroker).not.toHaveBeenCalled();
    expect(harness.calls).toHaveLength(0);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("blocks additional callbacks scheduled after each successful provider use", async () => {
    const harness = await snapshotHarness();
    const brokerRequests: GenericGitCredentialBrokerRequest[] = [];
    const lateCallbacks: Promise<void>[] = [];
    const provider: GenericGitSnapshotCredentialProvider = {
      provider: "basic",
      async use<T>(
        _signal: AbortSignal,
        operation: (
          credential: GenericGitSnapshotCredential,
        ) => T | Promise<T>,
      ): Promise<T> {
        const activeSecret = bytes("active-late-secret");
        const lateSecret = bytes("late-secret-must-not-start");
        lateCallbacks.push(
          new Promise<void>((resolve) => {
            globalThis.setTimeout(() => {
              void Promise.resolve(
                operation({
                  kind: "basic",
                  username: "safe-user",
                  secret: lateSecret,
                }),
              )
                .catch(() => undefined)
                .finally(() => {
                  lateSecret.fill(0);
                  resolve();
                });
            }, 100);
          }),
        );
        try {
          return await operation({
            kind: "basic",
            username: "safe-user",
            secret: activeSecret,
          });
        } finally {
          activeSecret.fill(0);
        }
      },
    };

    await snapshotGenericGitRepository(
      { repositoryUrl: "https://example.com/Org/Repo.git" },
      {
        ...harness.dependencies,
        credentialProvider: provider,
        createCredentialBroker: async (request) => {
          brokerRequests.push(request);
          return {
            helperCommand: "!'trusted-helper' helper 'pipe'",
            dispose: async () => undefined,
          };
        },
      },
    );
    await Promise.all(lateCallbacks);

    expect(brokerRequests).toHaveLength(3);
    for (const request of brokerRequests) {
      expect([...request.secret]).toEqual(
        Array(request.secret.byteLength).fill(0),
      );
    }
    expect(harness.calls.map(operationOf)).toEqual([
      "ls-remote",
      "init",
      "fetch",
      "rev-parse",
      "ls-remote",
      "archive",
    ]);
  });
});

describe("one-shot .NET credential broker launcher", () => {
  async function helperScript(
    source: string,
  ): Promise<string> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "code-city-broker-helper-"),
    );
    temporaryRoots.push(root);
    const script = path.join(root, "helper.mjs");
    await fs.writeFile(script, source, "utf8");
    return script;
  }

  function gitCredentialFill(
    helperCommand: string,
    input: Buffer,
    redactions: readonly string[],
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=${helperCommand}`,
          "-c",
          "credential.useHttpPath=true",
          "-c",
          "credential.interactive=false",
          "-c",
          "credential.protectProtocol=true",
          "credential",
          "fill",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "Never",
          },
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      let stderrOverflow = false;
      let settled = false;
      const clearStderr = (): void => {
        for (const chunk of stderr) chunk.fill(0);
        stderr.length = 0;
        stderrBytes = 0;
      };
      const clearStdout = (): void => {
        for (const chunk of stdout) chunk.fill(0);
        stdout.length = 0;
      };
      const failure = (code: number | null): Error => {
        const captured = Buffer.concat(stderr, stderrBytes);
        clearStderr();
        try {
          let diagnostic = captured.toString("utf8");
          for (const redaction of redactions) {
            diagnostic = diagnostic.replaceAll(redaction, "[redacted]");
          }
          diagnostic = diagnostic
            .replace(/[^\t\n\r\x20-\x7e]/gu, "?")
            .trim();
          if (diagnostic.length > 4_096) {
            diagnostic = diagnostic.slice(0, 4_096) + "...";
          }
          if (stderrOverflow) {
            diagnostic +=
              (diagnostic.length === 0 ? "" : " ") +
              "[stderr exceeded bound]";
          }
          return new Error(
            `git credential fill exited ${String(code)}: ${
              diagnostic.length === 0 ? "<empty stderr>" : diagnostic
            }`,
          );
        } finally {
          captured.fill(0);
        }
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        callback();
      };
      const timer = globalThis.setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => {
          clearStdout();
          clearStderr();
          reject(new Error("git credential fill timed out"));
        });
      }, 5_000);
      child.stdout.on("data", (chunk: Buffer) => {
        const copy = Buffer.from(chunk);
        if (settled) {
          copy.fill(0);
          return;
        }
        stdout.push(copy);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const copy = Buffer.from(chunk);
        if (settled || stderrOverflow) {
          copy.fill(0);
          return;
        }
        if (stderrBytes + copy.byteLength > 64 * 1024) {
          copy.fill(0);
          stderrOverflow = true;
          child.kill("SIGKILL");
          return;
        }
        stderr.push(copy);
        stderrBytes += copy.byteLength;
      });
      child.once("error", () =>
        finish(() => {
          clearStdout();
          reject(failure(null));
        }),
      );
      child.once("close", (code) =>
        finish(() => {
          if (code !== 0) {
            clearStdout();
            reject(failure(code));
            return;
          }
          clearStderr();
          const output = Buffer.concat(stdout);
          clearStdout();
          resolve(output);
        }),
      );
      child.stdin.end(input, () => input.fill(0));
    });
  }

  it("quotes trusted paths and rejects pipe-name shell injection", () => {
    expect(
      quoteGitCredentialHelperArgument(
        "C:\\Program Files\\O'Brien\\dotnet.exe",
      ),
    ).toBe("'C:\\Program Files\\O'\\''Brien\\dotnet.exe'");
    const command = gitCredentialHelperCommand(
      {
        executable: "C:\\Program Files\\dotnet.exe",
        assembly: "C:\\Trusted App\\helper.dll",
      },
      "codecity-git-" + "a".repeat(64),
    );
    expect(command).toBe(
      "!'C:\\Program Files\\dotnet.exe' " +
        "'C:\\Trusted App\\helper.dll' helper " +
        `'codecity-git-${"a".repeat(64)}'`,
    );
    expect(() =>
      gitCredentialHelperCommand(
        { executable: "/dotnet", assembly: "/helper.dll" },
        "pipe; touch owned",
      ),
    ).toThrow("failed safely");
  });

  it("serves an actual installed-Git credential fill through the bundled helper", async () => {
    const controller = new AbortController();
    const secret = bytes("p\u00e4ss/word=");
    let output: Buffer | undefined;
    const broker = await createGenericGitCredentialBroker({
      host: "example.com:8443",
      path: "Org/Project/_git/Repo Name.git",
      username: "user name",
      secret,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    try {
      output = await gitCredentialFill(
        broker.helperCommand,
        Buffer.from(
          "url=https://example.com:8443/" +
            "Org/Project/_git/Repo%20Name.git\n\n",
          "utf8",
        ),
        ["p\u00e4ss/word=", "user name"],
      );
      const text = output.toString("utf8");
      expect(text).toContain("protocol=https\n");
      expect(text).toContain("host=example.com:8443\n");
      expect(text).toContain(
        "path=Org/Project/_git/Repo Name.git\n",
      );
      expect(text).toContain("username=user name\n");
      expect(text).toContain("password=p\u00e4ss/word=\n");
    } finally {
      output?.fill(0);
      await broker.dispose();
      secret.fill(0);
    }
  });

  it("sends the bounded init frame, keeps stdin open, and awaits clean disposal", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "code-city-broker-observation-"),
    );
    temporaryRoots.push(root);
    const marker = path.join(root, "marker.json");
    const pipeName = `codecity-git-${"b".repeat(64)}`;
    const script = await helperScript(`
      import fs from "node:fs";
      import { once } from "node:events";
      const marker = ${JSON.stringify(marker)};
      async function readExactly(length) {
        const chunks = [];
        let total = 0;
        while (total < length) {
          const chunk = process.stdin.read(length - total);
          if (chunk !== null) {
            chunks.push(chunk);
            total += chunk.length;
          } else {
            await once(process.stdin, "readable");
          }
        }
        return Buffer.concat(chunks, total);
      }
      async function field() {
        const length = (await readExactly(4)).readUInt32BE(0);
        return readExactly(length);
      }
      const magic = await readExactly(8);
      const timeout = (await readExactly(4)).readUInt32BE(0);
      const host = await field();
      const path = await field();
      const username = await field();
      const secret = await field();
      await fs.promises.writeFile(marker, JSON.stringify({
        argument: process.argv[2],
        magic: magic.toString("ascii"),
        timeout,
        host: host.toString("utf8"),
        path: path.toString("utf8"),
        username: username.toString("utf8"),
        secretMatches: secret.equals(Buffer.from("p\u00e4ss=")),
        closed: false
      }));
      process.stdout.write(${JSON.stringify(`CCGITB1 ${pipeName}\n`)});
      await once(process.stdin, "end");
      const value = JSON.parse(await fs.promises.readFile(marker, "utf8"));
      value.closed = true;
      await fs.promises.writeFile(marker, JSON.stringify(value));
    `);
    const secret = bytes("p\u00e4ss=");

    const broker = await createGenericGitCredentialBroker(
      {
        host: "example.com:8443",
        path: "Org/Project/_git/Repo Name",
        username: "user name",
        secret,
        timeoutMs: 2_000,
        signal: new AbortController().signal,
      },
      {
        launch: {
          executable: process.execPath,
          assembly: script,
        },
      },
    );

    expect(broker.helperCommand).toContain(" helper ");
    expect(broker.helperCommand).toContain(pipeName);
    expect(broker.helperCommand).not.toContain("user name");
    expect(broker.helperCommand).not.toContain("p\u00e4ss=");
    expect(JSON.parse(await fs.readFile(marker, "utf8"))).toEqual({
      argument: "broker",
      magic: "CCGITB1\n",
      timeout: 2_000,
      host: "example.com:8443",
      path: "Org/Project/_git/Repo Name",
      username: "user name",
      secretMatches: true,
      closed: false,
    });

    await broker.dispose();
    expect(
      JSON.parse(await fs.readFile(marker, "utf8")).closed,
    ).toBe(true);
    await expect(broker.dispose()).resolves.toBeUndefined();
  });

  it("cleans up a broker that never becomes ready within a bounded time", async () => {
    const script = await helperScript(`
      process.stdin.resume();
      setInterval(() => undefined, 1000);
    `);
    const started = Date.now();

    await expect(
      createGenericGitCredentialBroker(
        {
          host: "example.com",
          path: "Org/Repo.git",
          username: "user",
          secret: bytes("secret"),
          timeoutMs: 50,
          signal: new AbortController().signal,
        },
        {
          launch: {
            executable: process.execPath,
            assembly: script,
          },
        },
      ),
    ).rejects.toThrow("failed safely");

    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it.each([
    {
      label: "invalid UTF-8 secret",
      secret: new Uint8Array([0xff]),
      timeoutMs: 1_000,
    },
    {
      label: "multiline secret",
      secret: bytes("secret\nsecond"),
      timeoutMs: 1_000,
    },
    {
      label: "timeout beyond the helper int32 contract",
      secret: bytes("secret"),
      timeoutMs: 0x8000_0000,
    },
  ])("rejects $label before launch", async ({ secret, timeoutMs }) => {
    await expect(
      createGenericGitCredentialBroker(
        {
          host: "example.com",
          path: "Org/Repo.git",
          username: "user",
          secret,
          timeoutMs,
          signal: new AbortController().signal,
        },
        {
          launch: {
            executable: process.execPath,
            assembly: path.join(os.tmpdir(), "does-not-run.dll"),
          },
        },
      ),
    ).rejects.toThrow("failed safely");
  });
});
