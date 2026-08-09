import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { provisionWindowsDevelopmentWorkspace } from "../apps/viewer/src/windows-development-workspace.js";

describe("Windows development history workspace", () => {
  it("creates an application-owned directory with a private inheritable ACL", async () => {
    const calls: Array<readonly [string, readonly string[]]> = [];
    const mkdir = vi.fn(async () => undefined);
    const workspace = await provisionWindowsDevelopmentWorkspace({
      localAppData: "C:\\Users\\developer\\AppData\\Local",
      systemRoot: "C:\\Windows",
      mkdir,
      inspectDirectory: async () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
      execute: async (file, arguments_) => {
        calls.push([file, arguments_]);
        return file.endsWith("whoami.exe")
          ? { stdout: '"workstation\\developer","S-1-5-21-1-2-3-1001"\r\n', stderr: "" }
          : { stdout: "processed 1 file", stderr: "" };
      },
    });

    expect(workspace).toEqual({
      dataDirectory:
        "C:\\Users\\developer\\AppData\\Local\\CodeCity\\development-data",
      trustWindowsGitWorkspace: true,
    });
    expect(mkdir).toHaveBeenNthCalledWith(
      1,
      "C:\\Users\\developer\\AppData\\Local\\CodeCity",
    );
    expect(mkdir).toHaveBeenNthCalledWith(2, workspace.dataDirectory);
    expect(calls).toEqual([
      [
        "C:\\Windows\\System32\\whoami.exe",
        ["/user", "/fo", "csv", "/nh"],
      ],
      [
        "C:\\Windows\\System32\\icacls.exe",
        ["C:\\Users\\developer\\AppData\\Local\\CodeCity", "/reset"],
      ],
      [
        "C:\\Windows\\System32\\icacls.exe",
        [
          "C:\\Users\\developer\\AppData\\Local\\CodeCity",
          "/inheritance:r",
          "/grant:r",
          "*S-1-5-21-1-2-3-1001:(OI)(CI)F",
          "*S-1-5-18:(OI)(CI)F",
          "*S-1-5-32-544:(OI)(CI)F",
        ],
      ],
      [
        "C:\\Windows\\System32\\icacls.exe",
        [
          "C:\\Users\\developer\\AppData\\Local\\CodeCity\\development-data",
          "/reset",
        ],
      ],
      [
        "C:\\Windows\\System32\\icacls.exe",
        [
          "C:\\Users\\developer\\AppData\\Local\\CodeCity\\development-data",
          "/inheritance:r",
          "/grant:r",
          "*S-1-5-21-1-2-3-1001:(OI)(CI)F",
          "*S-1-5-18:(OI)(CI)F",
          "*S-1-5-32-544:(OI)(CI)F",
        ],
      ],
    ]);
  });

  it.runIf(process.platform === "win32")(
    "applies the ACL with the real Windows system tools",
    async () => {
      const localAppData = await fs.mkdtemp(
        path.join(os.tmpdir(), "code-city-windows-workspace-"),
      );
      try {
        const workspace = await provisionWindowsDevelopmentWorkspace({
          localAppData,
        });
        expect((await fs.stat(workspace.dataDirectory)).isDirectory()).toBe(true);
        expect(workspace.trustWindowsGitWorkspace).toBe(true);
      } finally {
        await fs.rm(localAppData, { recursive: true, force: true });
      }
    },
  );

  it("fails closed for a reparse-point workspace root", async () => {
    await expect(
      provisionWindowsDevelopmentWorkspace({
        localAppData: "C:\\Users\\developer\\AppData\\Local",
        mkdir: async () => undefined,
        inspectDirectory: async () => ({
          isDirectory: () => true,
          isSymbolicLink: () => true,
        }),
        execute: async () => ({ stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("ordinary directory");
  });
});
