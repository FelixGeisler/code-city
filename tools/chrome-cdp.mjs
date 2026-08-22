import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const CHROME_ARGUMENTS = Object.freeze([
  "--headless=new",
  "--remote-debugging-port=0",
  "--user-data-dir=<temporary profile>",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function regularFile(candidate, statImpl) {
  try {
    return (await statImpl(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Discover only an installed, standard Google Chrome executable. */
export async function discoverInstalledChrome({
  platform = process.platform,
  environment = process.env,
  statImpl = stat,
} = {}) {
  if (platform === "win32") {
    for (const root of [environment.PROGRAMFILES, environment["PROGRAMFILES(X86)"]]) {
      if (typeof root !== "string" || root.length === 0) continue;
      const executable = path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe");
      if (await regularFile(executable, statImpl)) {
        return Object.freeze({ executable, category: "windows-program-files" });
      }
    }
  } else if (platform === "linux") {
    const searchPath = typeof environment.PATH === "string" ? environment.PATH : "";
    const directories = searchPath.split(":").filter((entry) => entry.length > 0);
    for (const command of ["google-chrome", "google-chrome-stable"]) {
      for (const directory of directories) {
        const executable = path.posix.join(directory, command);
        if (await regularFile(executable, statImpl)) {
          return Object.freeze({ executable, category: "linux-path" });
        }
      }
    }
  } else if (platform === "darwin") {
    const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (await regularFile(executable, statImpl)) {
      return Object.freeze({ executable, category: "macos-application" });
    }
  }
  throw new Error("Installed Google Chrome was not found; substitution and download are forbidden");
}

export async function readInstalledChromeVersion(discovery, {
  platform = process.platform,
  execFileImpl = execFile,
} = {}) {
  invariant(discovery && typeof discovery.executable === "string", "Chrome discovery is invalid");
  let stdout;
  if (platform === "win32") {
    const escaped = discovery.executable.replaceAll("'", "''");
    ({ stdout } = await execFileImpl("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
    ], { encoding: "utf8", windowsHide: true }));
  } else {
    ({ stdout } = await execFileImpl(discovery.executable, ["--version"], { encoding: "utf8" }));
  }
  const version = String(stdout).trim().replace(/^Google Chrome\s+/u, "");
  invariant(/^\d+\.\d+\.\d+\.\d+$/u.test(version), "Installed Google Chrome version could not be recorded");
  return version;
}

export async function launchInstalledChrome(discovery, profile, { spawnImpl = spawnProcess } = {}) {
  invariant(discovery && typeof discovery.executable === "string", "Chrome discovery is invalid");
  invariant(typeof profile === "string" && path.isAbsolute(profile), "Chrome profile must be an absolute path");
  const args = CHROME_ARGUMENTS.map((argument) => (
    argument === "--user-data-dir=<temporary profile>" ? `--user-data-dir=${profile}` : argument
  ));
  const child = spawnImpl(discovery.executable, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  invariant(child && child.stderr && typeof child.once === "function", "Chrome process could not be launched");
  let stderr = "";
  const websocketUrl = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    child.once("error", () => finish(new Error("Chrome process failed before CDP startup")));
    child.once("exit", () => finish(new Error("Chrome exited before CDP startup")));
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-16_384);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderr);
      if (match) finish(undefined, match[1]);
    });
  });
  invariant(/^ws:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d+\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(websocketUrl), "Chrome returned an invalid CDP endpoint");
  return Object.freeze({ child, websocketUrl, arguments: Object.freeze([...args]) });
}

export function connectCdp(websocketUrl, { WebSocketImpl = WebSocket } = {}) {
  const socket = new WebSocketImpl(websocketUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let openedResolve;
  let openedReject;
  const opened = new Promise((resolve, reject) => {
    openedResolve = resolve;
    openedReject = reject;
  });
  socket.addEventListener("open", () => openedResolve(), { once: true });
  socket.addEventListener("error", () => openedReject(new Error("CDP WebSocket failed to open")), { once: true });
  socket.addEventListener("close", () => {
    const error = new Error("CDP WebSocket closed");
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (Number.isSafeInteger(message?.id)) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error("CDP command failed"));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of [...listeners]) listener(message);
  });
  return Object.freeze({
    listeners,
    async send(method, params = {}, sessionId) {
      await opened;
      const id = nextId;
      nextId += 1;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return response;
    },
    close() {
      if (socket.readyState < WebSocketImpl.CLOSING) socket.close();
    },
  });
}
