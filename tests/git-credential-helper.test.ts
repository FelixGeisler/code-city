import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  gitCredentialHelperCommand,
  resolveBundledGitCredentialBrokerLaunch,
  type GenericGitCredentialBrokerLaunch,
} from "../packages/analyzer/src/git-credential-broker.js";

const HELPER_DLL = path.resolve(
  "tools",
  "git-credential-helper",
  "bin",
  "Release",
  "net10.0",
  "codecity-git-credential-helper.dll",
);
const PROCESS_TIMEOUT_MS = 8_000;
const MAXIMUM_CAPTURE_BYTES = 32 * 1024;
const activeProcesses = new Set<ChildProcessWithoutNullStreams>();
const temporaryDirectories: string[] = [];

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface RunningProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<ProcessExit>;
  readonly stdout: Promise<Buffer>;
  readonly stderr: Promise<Buffer>;
}

interface CompletedProcess extends ProcessExit {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface RunningBroker {
  readonly process: RunningProcess;
  readonly pipeName: string;
  readonly readiness: Buffer;
}

function zeroAll(buffers: readonly Buffer[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

function captureBounded(
  stream: Readable,
  maximumBytes = MAXIMUM_CAPTURE_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      zeroAll(chunks);
      reject(error);
    };

    stream.on("data", (value: Buffer | Uint8Array | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value)
        ? Buffer.from(value)
        : Buffer.from(value);
      if (length + chunk.length > maximumBytes) {
        chunk.fill(0);
        fail(new Error("Credential helper output exceeded its test bound."));
        return;
      }
      chunks.push(chunk);
      length += chunk.length;
    });
    stream.once("error", fail);
    stream.once("end", () => {
      if (settled) return;
      settled = true;
      const result = Buffer.concat(chunks, length);
      zeroAll(chunks);
      resolve(result);
    });
    stream.once("close", () => {
      if (!settled && !stream.readableEnded) {
        fail(new Error("Credential helper output closed unexpectedly."));
      }
    });
  });
}

function launchCommand(
  executable: string,
  arguments_: readonly string[],
  environment?: NodeJS.ProcessEnv,
): RunningProcess {
  const child = spawn(executable, arguments_, {
    ...(environment === undefined ? {} : { env: environment }),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  activeProcesses.add(child);

  const stdout = captureBounded(child.stdout);
  const stderr = captureBounded(child.stderr);
  const closed = new Promise<ProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      activeProcesses.delete(child);
      resolve({ code, signal });
    });
  });

  // Callers await these promises through complete(); these handlers also
  // prevent early process failures from becoming unhandled rejections.
  void stdout.catch(() => undefined);
  void stderr.catch(() => undefined);
  void closed.catch(() => undefined);
  return { child, closed, stdout, stderr };
}

function launch(arguments_: readonly string[]): RunningProcess {
  return launchCommand("dotnet", [HELPER_DLL, ...arguments_]);
}

function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${description} timed out.`));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function complete(
  process: RunningProcess,
): Promise<CompletedProcess> {
  const [exit, stdout, stderr] = await within(
    Promise.all([process.closed, process.stdout, process.stderr]),
    PROCESS_TIMEOUT_MS,
    "Credential helper process",
    () => {
      process.child.kill();
    },
  );
  return { ...exit, stdout, stderr };
}

function firstLine(stream: Readable): Promise<string> {
  const lines = createInterface({
    input: stream,
    crlfDelay: Infinity,
    terminal: false,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    lines.once("line", (line) => {
      settled = true;
      lines.close();
      resolve(line);
    });
    lines.once("close", () => {
      if (!settled) {
        reject(new Error("Credential broker closed before readiness."));
      }
    });
    lines.once("error", reject);
  });
}

function initializationFrame(
  timeoutMs: number,
  host: string,
  decodedPath: string,
  username: string,
  secret: string,
): Buffer {
  const magic = Buffer.from("CCGITB1\n", "ascii");
  const fields = [
    Buffer.from(host, "ascii"),
    Buffer.from(decodedPath, "utf8"),
    Buffer.from(username, "ascii"),
    Buffer.from(secret, "utf8"),
  ];
  const length =
    magic.length +
    4 +
    fields.reduce((total, field) => total + 4 + field.length, 0);
  const frame = Buffer.alloc(length);
  let offset = magic.copy(frame);
  frame.writeUInt32BE(timeoutMs, offset);
  offset += 4;
  for (const field of fields) {
    frame.writeUInt32BE(field.length, offset);
    offset += 4;
    offset += field.copy(frame, offset);
  }
  zeroAll([magic, ...fields]);
  return frame;
}

function credentialQuery(
  entries: readonly (readonly [key: string, value: string])[],
  termination: "eof" | "blank-line" = "eof",
): Buffer {
  return Buffer.from(
    `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}${
      termination === "blank-line" ? "\n\n" : "\n"
    }`,
    "utf8",
  );
}

function credentialQueryWithBinaryAdvisory(
  entries: readonly (readonly [key: string, value: string])[],
  key: string,
  value: Buffer,
): Buffer {
  const prefix = credentialQuery(entries);
  const attribute = Buffer.from(`${key}=`, "ascii");
  const terminator = Buffer.from("\n\n", "ascii");
  try {
    return Buffer.concat([prefix, attribute, value, terminator]);
  } finally {
    zeroAll([prefix, attribute, value, terminator]);
  }
}

function write(
  stream: Writable,
  buffer: Buffer,
  end: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const callback = (error?: Error | null): void => {
      buffer.fill(0);
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    };
    if (end) {
      stream.end(buffer, callback);
    } else {
      stream.write(buffer, callback);
    }
  });
}

async function startBroker(options: {
  readonly host: string;
  readonly decodedPath: string;
  readonly username: string;
  readonly secret: string;
}, dotnetLaunch?: GenericGitCredentialBrokerLaunch): Promise<RunningBroker> {
  const process =
    dotnetLaunch === undefined
      ? launch(["broker"])
      : launchCommand(dotnetLaunch.executable, [
          dotnetLaunch.assembly,
          "broker",
        ]);
  const readinessLine = firstLine(process.child.stdout);
  const frame = initializationFrame(
    15_000,
    options.host,
    options.decodedPath,
    options.username,
    options.secret,
  );
  await write(process.child.stdin, frame, false);
  const line = await within(
    readinessLine,
    PROCESS_TIMEOUT_MS,
    "Credential broker readiness",
    () => {
      process.child.kill();
    },
  );
  const match = /^CCGITB1 (codecity-git-[0-9a-f]{64})$/.exec(line);
  if (match?.[1] === undefined) {
    process.child.kill();
    throw new Error("Credential broker emitted malformed readiness.");
  }
  return {
    process,
    pipeName: match[1],
    readiness: Buffer.from(`${line}\n`, "ascii"),
  };
}

async function invoke(
  pipeName: string,
  operation: "get" | "store" | "erase",
  query: Buffer,
): Promise<CompletedProcess> {
  const process = launch(["helper", pipeName, operation]);
  await write(process.child.stdin, query, true);
  return complete(process);
}

function expectCleanExit(
  result: CompletedProcess,
  expectedStdout: Buffer,
): void {
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toEqual(Buffer.alloc(0));
  expect(result.stdout).toEqual(expectedStdout);
}

async function stopBroker(
  broker: RunningBroker,
): Promise<CompletedProcess> {
  broker.process.child.stdin.end();
  return complete(broker.process);
}

function installedGitIsAvailable(): boolean {
  const probe = spawnSync("git", ["--version"], {
    shell: false,
    stdio: "ignore",
    timeout: 3_000,
    windowsHide: true,
  });
  if (probe.error !== undefined) {
    if ((probe.error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw probe.error;
  }
  if (probe.status !== 0 || probe.signal !== null) {
    throw new Error("Installed Git failed its availability probe.");
  }
  return true;
}

async function isolatedGitEnvironment(): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-git-credential-helper-"),
  );
  temporaryDirectories.push(root);
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const appData = path.join(root, "app-data");
  const localAppData = path.join(root, "local-app-data");
  await Promise.all(
    [home, xdg, appData, localAppData].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  const globalConfig = path.join(root, "global.gitconfig");
  await fs.writeFile(globalConfig, "", { mode: 0o600 });

  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      name === "GIT_CONFIG_COUNT" ||
      name === "GIT_CONFIG_PARAMETERS" ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)
    ) {
      delete environment[name];
    }
  }
  delete environment["GIT_ASKPASS"];
  delete environment["SSH_ASKPASS"];
  environment["APPDATA"] = appData;
  environment["GCM_INTERACTIVE"] = "Never";
  environment["GIT_CONFIG_GLOBAL"] = globalConfig;
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["HOME"] = home;
  environment["LOCALAPPDATA"] = localAppData;
  environment["USERPROFILE"] = home;
  environment["XDG_CONFIG_HOME"] = xdg;
  return environment;
}

afterEach(async () => {
  const processes = [...activeProcesses];
  const closed = processes.map((process) => once(process, "close"));
  for (const process of processes) {
    process.stdin.destroy();
    process.kill();
  }
  await Promise.allSettled(closed);
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Git credential helper binary protocol", () => {
  it(
    "serves one exact Basic credential without persisting store or erase",
    async () => {
      const host = "git.example.test";
      const decodedPath = "Acme/Code City.git";
      const username = "Code City Bot";
      const secret = "pässwörd-城市-🔒";
      const broker = await startBroker({
        host,
        decodedPath,
        username,
        secret,
      });

      const store = await invoke(
        broker.pipeName,
        "store",
        credentialQuery([
          ["protocol", "https"],
          ["host", host],
          ["path", decodedPath],
          ["username", username],
          ["password", "must-not-be-persisted"],
        ]),
      );
      try {
        expectCleanExit(store, Buffer.alloc(0));
      } finally {
        zeroAll([store.stdout, store.stderr]);
      }

      const expectedCredential = Buffer.from(
        `username=${username}\npassword=${secret}\n\n`,
        "utf8",
      );
      const firstGet = await invoke(
        broker.pipeName,
        "get",
        credentialQueryWithBinaryAdvisory(
          [
            ["protocol", "https"],
            ["host", host.toUpperCase()],
            ["path", decodedPath],
            ["username", username],
            ["wwwauth[]", 'Basic realm="Code City"'],
            ["wwwauth[]", 'Bearer realm="Code City"'],
            ["capability[]", "authtype"],
            ["future-credential-context", "ignored"],
          ],
          "future-binary-context",
          Buffer.from([0xff, 0xfe, 0x09, 0x0d]),
        ),
      );
      try {
        expectCleanExit(firstGet, expectedCredential);
      } finally {
        zeroAll([firstGet.stdout, firstGet.stderr]);
      }

      const erase = await invoke(
        broker.pipeName,
        "erase",
        credentialQuery([
          ["protocol", "https"],
          ["host", host],
          ["path", decodedPath],
          ["username", username],
        ]),
      );
      try {
        expectCleanExit(erase, Buffer.alloc(0));
      } finally {
        zeroAll([erase.stdout, erase.stderr]);
      }

      const secondGet = await invoke(
        broker.pipeName,
        "get",
        credentialQuery([
          ["protocol", "https"],
          ["host", host],
          ["path", decodedPath],
        ]),
      );
      try {
        expectCleanExit(secondGet, expectedCredential);
      } finally {
        zeroAll([
          secondGet.stdout,
          secondGet.stderr,
          expectedCredential,
        ]);
      }

      const stopped = await stopBroker(broker);
      try {
        expectCleanExit(stopped, broker.readiness);
      } finally {
        zeroAll([
          stopped.stdout,
          stopped.stderr,
          broker.readiness,
        ]);
      }
    },
    20_000,
  );

  it(
    "rejects an adjacent repository path without disclosing credentials",
    async () => {
      const broker = await startBroker({
        host: "git.example.test",
        decodedPath: "Acme/Code-City.git",
        username: "Code City Bot",
        secret: "not-for-the-sibling-🔐",
      });
      const rejected = await invoke(
        broker.pipeName,
        "get",
        credentialQuery([
          ["protocol", "https"],
          ["host", "git.example.test"],
          ["path", "Acme/Code-City-Fork.git"],
          ["username", "Code City Bot"],
        ]),
      );
      try {
        const quit = Buffer.from("quit=1\n\n", "ascii");
        try {
          expectCleanExit(rejected, quit);
        } finally {
          quit.fill(0);
        }
      } finally {
        zeroAll([rejected.stdout, rejected.stderr]);
      }

      const stopped = await complete(broker.process);
      try {
        expectCleanExit(stopped, broker.readiness);
      } finally {
        zeroAll([
          stopped.stdout,
          stopped.stderr,
          broker.readiness,
        ]);
      }
    },
    20_000,
  );

  it(
    "serves installed Git credential fill through the quoted helper command",
    async ({ skip }) => {
      if (!installedGitIsAvailable()) {
        skip("Git is not installed.");
        return;
      }

      const dotnetLaunch =
        await resolveBundledGitCredentialBrokerLaunch();
      expect(path.isAbsolute(dotnetLaunch.executable)).toBe(true);
      expect(path.isAbsolute(dotnetLaunch.assembly)).toBe(true);
      const host = "git.example.test";
      const decodedPath = "Acme/Code City.git";
      const username = "Code City Bot";
      const secret = "Git-päss-城市-🔒";
      const broker = await startBroker(
        { host, decodedPath, username, secret },
        dotnetLaunch,
      );
      try {
        const helperCommand = gitCredentialHelperCommand(
          dotnetLaunch,
          broker.pipeName,
        );
        expect(helperCommand.startsWith("!")).toBe(true);
        expect(helperCommand).not.toContain(secret);
        const git = launchCommand(
          "git",
          [
            "-c",
            "credential.helper=",
            "-c",
            `credential.helper=${helperCommand}`,
            "-c",
            "credential.useHttpPath=true",
            "credential",
            "fill",
          ],
          await isolatedGitEnvironment(),
        );
        const gitInput = Buffer.from(
          [
            "url=https://git.example.test/Acme/Code%20City.git",
            'wwwauth[]=Basic realm="Code City"',
            "",
            "",
          ].join("\n"),
          "ascii",
        );
        await write(git.child.stdin, gitInput, true);
        const result = await complete(git);
        const expected = Buffer.from(
          [
            "protocol=https",
            `host=${host}`,
            `path=${decodedPath}`,
            `username=${username}`,
            `password=${secret}`,
            'wwwauth[]=Basic realm="Code City"',
            "",
          ].join("\n"),
          "utf8",
        );
        try {
          expectCleanExit(result, expected);
        } finally {
          zeroAll([result.stdout, result.stderr, expected]);
        }

        const stopped = await stopBroker(broker);
        try {
          expectCleanExit(stopped, broker.readiness);
        } finally {
          zeroAll([stopped.stdout, stopped.stderr]);
        }
      } finally {
        broker.readiness.fill(0);
      }
    },
    25_000,
  );
});
