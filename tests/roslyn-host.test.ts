import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  analyzeCSharpWithRoslyn,
  resolveBundledRoslynLaunch,
  ROSLYN_PROTOCOL_VERSION,
  type RoslynHelperLaunch,
} from "../packages/analyzer/src/roslyn-host.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-roslyn-host-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function nodeHelper(source: string): RoslynHelperLaunch {
  return {
    executable: process.execPath,
    arguments: ["--input-type=module", "--eval", source],
  };
}

const readRequest =
  "const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);" +
  "const request=JSON.parse(Buffer.concat(chunks));";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("uses one shell-free helper process for a sorted versioned batch", async () => {
  const directory = await temporaryDirectory();
  const marker = path.join(directory, "invocations.txt");
  const source =
    `${readRequest}` +
    `const fs=await import("node:fs/promises");` +
    `await fs.appendFile(${JSON.stringify(marker)},"1");` +
    `process.stdout.write(JSON.stringify({protocolVersion:request.protocolVersion,files:request.files.map(file=>({id:file.id,status:"ok",metricMethod:"csharp-roslyn-v1",sloc:1,decisionLoad:0,maximumComplexity:1,executableUnitCount:1,units:[{name:"<top-level>",line:1,complexity:1}],warnings:[]}))}));`;

  const outcomes = await analyzeCSharpWithRoslyn(
    [
      { id: "source-000002.cs", source: "class Z {}" },
      { id: "source-000001.cs", source: "class A {}" },
    ],
    nodeHelper(source),
  );

  expect(await fs.readFile(marker, "utf8")).toBe("1");
  expect(outcomes.map(({ id }) => id)).toEqual([
    "source-000001.cs",
    "source-000002.cs",
  ]);
  expect(outcomes[0]).toMatchObject({
    status: "ok",
    metricMethod: "csharp-roslyn-v1",
    metrics: { sloc: 1, maximumComplexity: 1 },
  });
});

it("terminates the helper when bounded stdout is exceeded", async () => {
  await expect(
    analyzeCSharpWithRoslyn(
      [{ id: "source-000001.cs", source: "class A {}" }],
      nodeHelper(
        `${readRequest}process.stdout.write(${JSON.stringify("x".repeat(128))});`,
      ),
      { maximumStdoutBytes: 32 },
    ),
  ).rejects.toThrow("output exceeded its byte limit");
});

it("cancels the helper through AbortSignal", async () => {
  const controller = new AbortController();
  const cancellation = setTimeout(() => controller.abort(), 30);
  try {
    await expect(
      analyzeCSharpWithRoslyn(
        [{ id: "source-000001.cs", source: "class A {}" }],
        nodeHelper(
          "process.stdin.resume();setTimeout(()=>process.exit(0),10000);",
        ),
        { signal: controller.signal, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow("cancelled");
  } finally {
    clearTimeout(cancellation);
  }
});

it("honors cancellation that races AbortSignal listener registration", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const addEventListener = signal.addEventListener.bind(signal);
  vi.spyOn(signal, "addEventListener").mockImplementation(
    (type, listener, options) => {
      if (type === "abort") controller.abort();
      addEventListener(type, listener, options);
    },
  );

  await expect(
    analyzeCSharpWithRoslyn(
      [{ id: "source-000001.cs", source: "class A {}" }],
      nodeHelper(
        "process.stdin.resume();setTimeout(()=>process.exit(0),10000);",
      ),
      { signal, timeoutMs: 100 },
    ),
  ).rejects.toThrow("cancelled");
});

it("ignores relative DOTNET_ROOT and PATH launch candidates", async () => {
  const directory = await temporaryDirectory();
  const previousCwd = process.cwd();
  const previousDotnetRoot = process.env["DOTNET_ROOT"];
  const previousPath = process.env["PATH"];
  const executableName =
    process.platform === "win32" ? "dotnet.exe" : "dotnet";
  for (const relativeDirectory of ["runtime", "bin"]) {
    const candidateDirectory = path.join(directory, relativeDirectory);
    await fs.mkdir(candidateDirectory, { recursive: true });
    const candidate = path.join(candidateDirectory, executableName);
    await fs.writeFile(candidate, "repository-controlled fake dotnet", "utf8");
    if (process.platform !== "win32") await fs.chmod(candidate, 0o755);
  }

  try {
    process.chdir(directory);
    process.env["DOTNET_ROOT"] = "runtime";
    process.env["PATH"] = "bin";
    await expect(resolveBundledRoslynLaunch()).rejects.toThrow(
      "pinned .NET runtime",
    );
  } finally {
    process.chdir(previousCwd);
    if (previousDotnetRoot === undefined) {
      delete process.env["DOTNET_ROOT"];
    } else {
      process.env["DOTNET_ROOT"] = previousDotnetRoot;
    }
    if (previousPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = previousPath;
    }
  }
});

it("rejects malformed or incompatible protocol output", async () => {
  await expect(
    analyzeCSharpWithRoslyn(
      [{ id: "source-000001.cs", source: "class A {}" }],
      nodeHelper(
        `${readRequest}process.stdout.write(JSON.stringify({protocolVersion:"wrong",files:[]}));`,
      ),
    ),
  ).rejects.toThrow("incompatible protocol response");
});

it("rejects unsafe inputs before starting the helper", async () => {
  await expect(
    analyzeCSharpWithRoslyn(
      [{ id: "../secret.cs", source: "token" }],
      nodeHelper(
        `process.stdout.write(${JSON.stringify(ROSLYN_PROTOCOL_VERSION)});`,
      ),
    ),
  ).rejects.toThrow("opaque portable");
});
