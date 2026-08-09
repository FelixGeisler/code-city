import { execFile as executeFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(executeFile);
const SID_PATTERN = /\bS-\d(?:-\d+)+\b/u;
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

export interface WindowsDevelopmentWorkspaceOptions {
  readonly localAppData?: string;
  readonly systemRoot?: string;
  readonly execute?: (
    file: string,
    arguments_: readonly string[],
  ) => Promise<Readonly<{ stdout: string; stderr: string }>>;
  readonly mkdir?: (directory: string) => Promise<void>;
  readonly inspectDirectory?: (
    directory: string,
  ) => Promise<Readonly<{ isDirectory(): boolean; isSymbolicLink(): boolean }>>;
}

export interface WindowsDevelopmentWorkspace {
  readonly dataDirectory: string;
  readonly trustWindowsGitWorkspace: true;
}

async function defaultExecute(
  file: string,
  arguments_: readonly string[],
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return await execFile(file, arguments_, {
    encoding: "utf8",
    windowsHide: true,
  });
}

/** Provisions the private, application-owned workspace used only by viewer:dev. */
export async function provisionWindowsDevelopmentWorkspace(
  options: WindowsDevelopmentWorkspaceOptions = {},
): Promise<WindowsDevelopmentWorkspace> {
  const localAppData = options.localAppData ?? process.env["LOCALAPPDATA"];
  if (localAppData === undefined || !path.win32.isAbsolute(localAppData)) {
    throw new Error(
      "Windows development history needs an absolute LOCALAPPDATA directory.",
    );
  }
  const systemRoot = options.systemRoot ?? process.env["SystemRoot"] ?? "C:\\Windows";
  if (!path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot must be an absolute directory.");
  }
  const execute = options.execute ?? defaultExecute;
  const mkdir = options.mkdir ?? (async (directory: string) => {
    await fs.mkdir(directory, { recursive: true });
  });
  const inspectDirectory = options.inspectDirectory ?? (async (directory: string) =>
    await fs.lstat(directory));
  const applicationRoot = path.win32.join(localAppData, "CodeCity");
  const dataDirectory = path.win32.join(applicationRoot, "development-data");
  await mkdir(applicationRoot);
  const rootStatus = await inspectDirectory(applicationRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error(
      "The Windows Code City development workspace root must be an ordinary directory.",
    );
  }

  const whoami = path.win32.join(systemRoot, "System32", "whoami.exe");
  const identity = await execute(whoami, ["/user", "/fo", "csv", "/nh"]);
  const currentUserSid = identity.stdout.match(SID_PATTERN)?.[0];
  if (currentUserSid === undefined) {
    throw new Error("Windows did not report the current user SID.");
  }

  const icacls = path.win32.join(systemRoot, "System32", "icacls.exe");
  const secureDirectory = async (directory: string): Promise<void> => {
    // Reset removes any pre-existing explicit grants before inheritance is
    // removed. The second command leaves exactly the three trusted principals.
    await execute(icacls, [directory, "/reset"]);
    await execute(icacls, [
      directory,
      "/inheritance:r",
      "/grant:r",
      `*${currentUserSid}:(OI)(CI)F`,
      `*${SYSTEM_SID}:(OI)(CI)F`,
      `*${ADMINISTRATORS_SID}:(OI)(CI)F`,
    ]);
  };
  await secureDirectory(applicationRoot);
  await mkdir(dataDirectory);
  const dataStatus = await inspectDirectory(dataDirectory);
  if (!dataStatus.isDirectory() || dataStatus.isSymbolicLink()) {
    throw new Error(
      "The Windows Code City development data path must be an ordinary directory.",
    );
  }
  await secureDirectory(dataDirectory);

  return Object.freeze({
    dataDirectory,
    trustWindowsGitWorkspace: true,
  });
}
