import { promises as fs, type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGenericGitTemporaryWorkspace,
  GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
  GENERIC_GIT_PRESECURED_WINDOWS_ACL,
  type GenericGitSnapshotError,
  type GenericGitTemporaryWorkspaceOptions,
} from "../packages/analyzer/src/git-snapshot.js";

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function createPrivateParent(
  sandbox: string,
  name = "private",
): Promise<string> {
  const parent = path.join(sandbox, name);
  await fs.mkdir(parent, { recursive: false, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(parent, 0o700);
  }
  return parent;
}

function trustedPrivateParent(
  directory: string,
): GenericGitTemporaryWorkspaceOptions {
  return {
    trustedPrivateParent: {
      directory,
      windowsAclProtection:
        GENERIC_GIT_PRESECURED_WINDOWS_ACL,
      canonicalAncestryProtection:
        GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
    },
  };
}

function expectContained(
  parent: string,
  candidate: string,
): void {
  const relative = path.relative(parent, candidate);
  expect(relative).not.toBe("");
  expect(path.isAbsolute(relative)).toBe(false);
  expect(relative).not.toBe("..");
  expect(relative.startsWith(`..${path.sep}`)).toBe(false);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("generic Git temporary workspaces", () => {
  it("uses a verified default OS temp boundary or fails closed on Windows", async () => {
    if (process.platform === "win32") {
      await expect(
        createGenericGitTemporaryWorkspace(),
      ).rejects.toMatchObject({
        code: "GIT_TEMPORARY_WORKSPACE_INVALID",
        message: expect.stringContaining(
          "--trusted-workspace-parent",
        ),
      } satisfies Partial<GenericGitSnapshotError>);
      return;
    }
    const workspace = await createGenericGitTemporaryWorkspace();
    temporaryRoots.push(workspace.root);

    expectContained(
      await fs.realpath(os.tmpdir()),
      await fs.realpath(workspace.root),
    );
    expect(path.basename(workspace.root)).toMatch(
      /^code-city-git-/u,
    );

    await workspace.dispose();
    await expect(fs.lstat(workspace.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates unique mode-0700 children beneath a configured parent", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-parent-test-",
    );
    const configuredParent = await createPrivateParent(
      sandbox,
      "imports",
    );
    const first = await createGenericGitTemporaryWorkspace(
      trustedPrivateParent(configuredParent),
    );
    const second = await createGenericGitTemporaryWorkspace(
      trustedPrivateParent(configuredParent),
    );
    const canonicalParent = await fs.realpath(configuredParent);
    const canonicalFirst = await fs.realpath(first.root);
    const canonicalSecond = await fs.realpath(second.root);

    expect(first.root).not.toBe(second.root);
    expectContained(canonicalParent, canonicalFirst);
    expectContained(canonicalParent, canonicalSecond);
    expect(path.dirname(canonicalFirst)).toBe(canonicalParent);
    expect(path.dirname(canonicalSecond)).toBe(canonicalParent);
    expect((await fs.lstat(first.root)).isDirectory()).toBe(true);
    expect((await fs.lstat(first.templateDirectory)).isDirectory()).toBe(
      true,
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(first.root)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(first.templateDirectory)).mode & 0o777,
      ).toBe(0o700);
    }

    const renameSpy = vi.spyOn(fs, "rename");
    await Promise.all([
      first.dispose(),
      first.dispose(),
      first.dispose(),
      second.dispose(),
    ]);
    expect(
      renameSpy.mock.calls.filter(
        ([source]) => String(source) === first.root,
      ),
    ).toHaveLength(1);
    await expect(fs.lstat(first.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.lstat(second.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await fs.lstat(configuredParent)).isDirectory()).toBe(true);
  });

  it("rejects a configured parent that is a regular file", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-file-parent-test-",
    );
    const configuredParent = path.join(sandbox, "not-a-directory");
    await fs.writeFile(configuredParent, "not a directory");

    await expect(
      createGenericGitTemporaryWorkspace(
        trustedPrivateParent(configuredParent),
      ),
    ).rejects.toMatchObject({
      code: "GIT_TEMPORARY_WORKSPACE_INVALID",
    } satisfies Partial<GenericGitSnapshotError>);
  });

  it("rejects a configured parent that is a symbolic link", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-link-parent-test-",
    );
    const target = path.join(sandbox, "target");
    const configuredParent = path.join(sandbox, "parent-link");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(
      target,
      configuredParent,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      createGenericGitTemporaryWorkspace(
        trustedPrivateParent(configuredParent),
      ),
    ).rejects.toMatchObject({
      code: "GIT_TEMPORARY_WORKSPACE_INVALID",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(fs.readdir(target)).resolves.toEqual([]);
  });

  it("requires a custom trusted parent to exist already", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-missing-parent-test-",
    );
    const configuredParent = path.join(sandbox, "missing");

    await expect(
      createGenericGitTemporaryWorkspace(
        trustedPrivateParent(configuredParent),
      ),
    ).rejects.toMatchObject({
      code: "GIT_TEMPORARY_WORKSPACE_INVALID",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(fs.lstat(configuredParent)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires an explicit trusted-boundary object and Windows ACL precondition", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-explicit-boundary-test-",
    );
    const configuredParent = await createPrivateParent(sandbox);

    await expect(
      createGenericGitTemporaryWorkspace(
        configuredParent as unknown as GenericGitTemporaryWorkspaceOptions,
      ),
    ).rejects.toMatchObject({
      code: "GIT_TEMPORARY_WORKSPACE_INVALID",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(
      createGenericGitTemporaryWorkspace({
        trustedPrivateParent: {
          directory: configuredParent,
          windowsAclProtection:
            "chmod-is-private" as typeof GENERIC_GIT_PRESECURED_WINDOWS_ACL,
          canonicalAncestryProtection:
            GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
        },
      }),
    ).rejects.toMatchObject({
      code: "GIT_TEMPORARY_WORKSPACE_INVALID",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(
      createGenericGitTemporaryWorkspace({
        trustedPrivateParent: {
          directory: configuredParent,
          windowsAclProtection:
            GENERIC_GIT_PRESECURED_WINDOWS_ACL,
          canonicalAncestryProtection:
            "rename-is-fine" as typeof GENERIC_GIT_PRESECURED_CANONICAL_ANCESTRY,
        },
      }),
    ).rejects.toMatchObject({
      code: "GIT_TEMPORARY_WORKSPACE_INVALID",
    } satisfies Partial<GenericGitSnapshotError>);

    const workspace = await createGenericGitTemporaryWorkspace(
      trustedPrivateParent(configuredParent),
    );
    await workspace.dispose();
  });

  it("rejects a zero device/inode identity for a trusted boundary", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-zero-identity-test-",
    );
    const configuredParent = await createPrivateParent(sandbox);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(
      async (candidate, options) => {
        const status = await originalLstat(candidate, options);
        if (
          typeof status.dev !== "bigint" ||
          path.resolve(String(candidate)) !==
            path.resolve(configuredParent)
        ) {
          return status;
        }
        return new Proxy(status, {
          get(target, property) {
            if (property === "dev" || property === "ino") {
              return 0n;
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function"
              ? value.bind(target)
              : value;
          },
        }) as BigIntStats;
      },
    );

    await expect(
      createGenericGitTemporaryWorkspace(
        trustedPrivateParent(configuredParent),
      ),
    ).rejects.toMatchObject({
      code: "GIT_TEMPORARY_WORKSPACE_INVALID",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(fs.readdir(configuredParent)).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects an existing custom parent with non-private permissions",
    async () => {
      const sandbox = await temporaryDirectory(
        "code-city-git-insecure-parent-test-",
      );
      const configuredParent = path.join(sandbox, "shared");
      await fs.mkdir(configuredParent, { mode: 0o777 });
      await fs.chmod(configuredParent, 0o777);

      await expect(
        createGenericGitTemporaryWorkspace(
          trustedPrivateParent(configuredParent),
        ),
      ).rejects.toMatchObject({
        code: "GIT_TEMPORARY_WORKSPACE_INVALID",
      } satisfies Partial<GenericGitSnapshotError>);
      expect((await fs.stat(configuredParent)).mode & 0o777).toBe(
        0o777,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an insecure canonical ancestor of a private custom parent",
    async () => {
      const sandbox = await temporaryDirectory(
        "code-city-git-insecure-ancestor-test-",
      );
      const insecureAncestor = path.join(sandbox, "shared");
      await fs.mkdir(insecureAncestor, { mode: 0o777 });
      await fs.chmod(insecureAncestor, 0o777);
      const configuredParent = await createPrivateParent(
        insecureAncestor,
        "private",
      );

      await expect(
        createGenericGitTemporaryWorkspace(
          trustedPrivateParent(configuredParent),
        ),
      ).rejects.toMatchObject({
        code: "GIT_TEMPORARY_WORKSPACE_INVALID",
      } satisfies Partial<GenericGitSnapshotError>);
      expect(
        (await fs.stat(insecureAncestor)).mode & 0o1777,
      ).toBe(0o777);
      await expect(fs.readdir(configuredParent)).resolves.toEqual(
        [],
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an insecure environment-selected default temp directory",
    async () => {
      const sandbox = await temporaryDirectory(
        "code-city-git-insecure-default-test-",
      );
      const insecureDefault = path.join(sandbox, "shared-temp");
      await fs.mkdir(insecureDefault, { mode: 0o777 });
      await fs.chmod(insecureDefault, 0o777);
      const previous = {
        TMPDIR: process.env["TMPDIR"],
        TMP: process.env["TMP"],
        TEMP: process.env["TEMP"],
      };
      process.env["TMPDIR"] = insecureDefault;
      delete process.env["TMP"];
      delete process.env["TEMP"];
      try {
        expect(path.resolve(os.tmpdir())).toBe(
          path.resolve(insecureDefault),
        );
        await expect(
          createGenericGitTemporaryWorkspace(),
        ).rejects.toMatchObject({
          code: "GIT_TEMPORARY_WORKSPACE_INVALID",
        } satisfies Partial<GenericGitSnapshotError>);
        await expect(fs.readdir(insecureDefault)).resolves.toEqual(
          [],
        );
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );

  it("detects replacement of the trusted parent before workspace use", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-parent-race-test-",
    );
    const configuredParent = await createPrivateParent(sandbox);
    const workspace = await createGenericGitTemporaryWorkspace(
      trustedPrivateParent(configuredParent),
    );
    const originalParent = path.join(sandbox, "private-original");
    await fs.rename(configuredParent, originalParent);
    await fs.mkdir(configuredParent, { mode: 0o700 });
    if (process.platform !== "win32") {
      await fs.chmod(configuredParent, 0o700);
    }

    await expect(
      workspace.measureBytes(1024, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "GIT_TEMPORARY_WORKSPACE_INVALID",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(workspace.dispose()).rejects.toMatchObject({
      code: "GIT_CLEANUP_FAILED",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(fs.lstat(configuredParent)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(
      fs.lstat(
        path.join(originalParent, path.basename(workspace.root)),
      ),
    ).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("preserves a replacement and the renamed original when cleanup identity changes", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-root-replacement-test-",
    );
    const configuredParent = await createPrivateParent(sandbox);
    const workspace = await createGenericGitTemporaryWorkspace(
      trustedPrivateParent(configuredParent),
    );
    const originalRoot = `${workspace.root}-original`;
    await fs.rename(workspace.root, originalRoot);
    await fs.mkdir(workspace.root, { mode: 0o700 });
    if (process.platform !== "win32") {
      await fs.chmod(workspace.root, 0o700);
    }
    const sentinel = path.join(workspace.root, "replacement.txt");
    await fs.writeFile(sentinel, "preserve me");

    await expect(workspace.dispose()).rejects.toMatchObject({
      code: "GIT_CLEANUP_FAILED",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe(
      "preserve me",
    );
    expect((await fs.lstat(originalRoot)).isDirectory()).toBe(true);
  });

  it("fails closed when a replacement appears during atomic cleanup", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-root-cleanup-race-test-",
    );
    const configuredParent = await createPrivateParent(sandbox);
    const workspace = await createGenericGitTemporaryWorkspace(
      trustedPrivateParent(configuredParent),
    );
    const originalRename = fs.rename.bind(fs);
    const sentinel = path.join(workspace.root, "replacement.txt");
    let replaced = false;
    vi.spyOn(fs, "rename").mockImplementation(
      async (source, destination) => {
        await originalRename(source, destination);
        if (!replaced && String(source) === workspace.root) {
          replaced = true;
          await fs.mkdir(workspace.root, { mode: 0o700 });
          if (process.platform !== "win32") {
            await fs.chmod(workspace.root, 0o700);
          }
          await fs.writeFile(sentinel, "preserve me");
        }
      },
    );

    await expect(workspace.dispose()).rejects.toMatchObject({
      code: "GIT_CLEANUP_FAILED",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe(
      "preserve me",
    );
    const quarantines = (await fs.readdir(configuredParent)).filter(
      (entry) => entry.startsWith(".code-city-git-cleanup-"),
    );
    expect(quarantines).toHaveLength(1);
    expect(
      (
        await fs.lstat(
          path.join(configuredParent, quarantines[0] ?? ""),
        )
      ).isDirectory(),
    ).toBe(true);
  });

  it("does not report successful cleanup when the original root is missing", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-root-missing-test-",
    );
    const configuredParent = await createPrivateParent(sandbox);
    const workspace = await createGenericGitTemporaryWorkspace(
      trustedPrivateParent(configuredParent),
    );
    const movedRoot = `${workspace.root}-moved`;
    await fs.rename(workspace.root, movedRoot);

    const first = workspace.dispose();
    const second = workspace.dispose();
    await expect(first).rejects.toMatchObject({
      code: "GIT_CLEANUP_FAILED",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(second).rejects.toMatchObject({
      code: "GIT_CLEANUP_FAILED",
    } satisfies Partial<GenericGitSnapshotError>);
    expect((await fs.lstat(movedRoot)).isDirectory()).toBe(true);
  });

  it("retries the same trusted quarantine after recursive cleanup fails", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-cleanup-failure-test-",
    );
    const configuredParent = await createPrivateParent(sandbox);
    const workspace = await createGenericGitTemporaryWorkspace(
      trustedPrivateParent(configuredParent),
    );
    const renameSpy = vi.spyOn(fs, "rename");
    const originalRemove = fs.rm.bind(fs);
    let simulatedFailure = false;
    vi.spyOn(fs, "rm").mockImplementation(
      async (candidate, options) => {
        if (
          !simulatedFailure &&
          path
            .basename(String(candidate))
            .startsWith(".code-city-git-cleanup-")
        ) {
          simulatedFailure = true;
          throw Object.assign(new Error("simulated failure"), {
            code: "EACCES",
          });
        }
        await originalRemove(candidate, options);
      },
    );

    const firstAttempt = workspace.dispose();
    const concurrentAttempt = workspace.dispose();
    await expect(firstAttempt).rejects.toMatchObject({
      code: "GIT_CLEANUP_FAILED",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(concurrentAttempt).rejects.toMatchObject({
      code: "GIT_CLEANUP_FAILED",
    } satisfies Partial<GenericGitSnapshotError>);
    const entries = await fs.readdir(configuredParent);
    const quarantines = entries.filter((entry) =>
      entry.startsWith(".code-city-git-cleanup-"),
    );
    expect(quarantines).toHaveLength(1);
    expect(
      (
        await fs.lstat(
          path.join(configuredParent, quarantines[0] ?? ""),
        )
      ).isDirectory(),
    ).toBe(true);
    await expect(fs.lstat(workspace.root)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(workspace.dispose()).resolves.toBeUndefined();
    await expect(workspace.dispose()).resolves.toBeUndefined();
    await expect(
      fs.lstat(path.join(configuredParent, quarantines[0] ?? "")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(configuredParent)).resolves.toEqual([]);
    expect(
      renameSpy.mock.calls.filter(
        ([source]) => String(source) === workspace.root,
      ),
    ).toHaveLength(1);
  });

  it("finishes a retry when removal succeeded before reporting failure", async () => {
    const sandbox = await temporaryDirectory(
      "code-city-git-cleanup-post-remove-failure-test-",
    );
    const configuredParent = await createPrivateParent(sandbox);
    const workspace = await createGenericGitTemporaryWorkspace(
      trustedPrivateParent(configuredParent),
    );
    const sentinel = path.join(workspace.root, "replacement.txt");
    const originalRemove = fs.rm.bind(fs);
    let simulatedFailure = false;
    vi.spyOn(fs, "rm").mockImplementation(
      async (candidate, options) => {
        await originalRemove(candidate, options);
        if (
          !simulatedFailure &&
          path
            .basename(String(candidate))
            .startsWith(".code-city-git-cleanup-")
        ) {
          simulatedFailure = true;
          await fs.mkdir(workspace.root, { mode: 0o700 });
          if (process.platform !== "win32") {
            await fs.chmod(workspace.root, 0o700);
          }
          await fs.writeFile(sentinel, "replacement survives");
          throw Object.assign(new Error("reported after deletion"), {
            code: "EIO",
          });
        }
      },
    );

    await expect(workspace.dispose()).rejects.toMatchObject({
      code: "GIT_CLEANUP_FAILED",
    } satisfies Partial<GenericGitSnapshotError>);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe(
      "replacement survives",
    );

    await expect(workspace.dispose()).resolves.toBeUndefined();
    await expect(workspace.dispose()).resolves.toBeUndefined();
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe(
      "replacement survives",
    );
    expect(
      (await fs.readdir(configuredParent)).filter((entry) =>
        entry.startsWith(".code-city-git-cleanup-"),
      ),
    ).toEqual([]);
  });
});
