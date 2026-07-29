import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  publishPrivateJson,
  readBoundedJsonFile,
} from "../apps/cli/src/json-file.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-json-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function transactionFiles(directory: string): Promise<readonly string[]> {
  return (await fs.readdir(directory)).filter((entry) =>
    entry.startsWith(".codecity-"),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("accepts JSON exactly at the byte limit", async () => {
  const directory = await temporaryDirectory();
  const input = path.join(directory, "profile.json");
  const text = '{"safe":true}';
  await fs.writeFile(input, text, "utf8");

  await expect(
    readBoundedJsonFile(input, "printer profile", Buffer.byteLength(text)),
  ).resolves.toEqual({ safe: true });
});

it("stops oversized JSON at the byte boundary without disclosing its path or content", async () => {
  const directory = await temporaryDirectory();
  const input = path.join(directory, "credential-secret.json");
  await fs.writeFile(input, '{"token":"never-report-this"}', "utf8");

  let message = "";
  try {
    await readBoundedJsonFile(input, "printer profile", 8);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toBe("printer profile input exceeds the 8-byte limit.");
  expect(message).not.toContain(directory);
  expect(message).not.toContain("never-report-this");
});

it("does not echo an unreadable input path", async () => {
  const directory = await temporaryDirectory();
  const missing = path.join(directory, "private-name.json");

  await expect(
    readBoundedJsonFile(missing, "city model", 64),
  ).rejects.toThrow("Cannot read city model input (ENOENT).");
  await expect(
    readBoundedJsonFile(missing, "city model", 64),
  ).rejects.not.toThrow(directory);
});

it("publishes derived JSON privately and without transaction residue", async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, "model.json");

  const published = await publishPrivateJson(
    output,
    { schemaVersion: "1.0" },
    "city model",
  );

  expect(published).toBe(path.resolve(output));
  expect(JSON.parse(await fs.readFile(output, "utf8"))).toEqual({
    schemaVersion: "1.0",
  });
  expect(await transactionFiles(directory)).toEqual([]);
  if (process.platform !== "win32") {
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
  }
});

it("restores the previous JSON and cleans staged files after publication failure", async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, "plan.json");
  await fs.writeFile(output, "previous plan", "utf8");

  await expect(
    publishPrivateJson(output, { replacement: true }, "print plan", {
      beforePublish: () => {
        throw new Error("private injected detail");
      },
    }),
  ).rejects.toThrow("Cannot publish print plan atomically.");

  expect(await fs.readFile(output, "utf8")).toBe("previous plan");
  expect(await transactionFiles(directory)).toEqual([]);
});
