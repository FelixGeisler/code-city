import path from "node:path";
import { pathToFileURL } from "node:url";

import { startCodeCityServer } from "./server.js";
import {
  AI_GUIDANCE_CONFIG_VERSION,
  type AiGuidanceConfiguration,
} from "./ai-guidance.js";

function environmentPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("CODECITY_PORT must be an integer from 1 to 65535.");
  }
  return parsed;
}

function environmentAllowedHosts(
  value: string | undefined,
): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const hosts = value.split(",").map((host) => host.trim());
  if (hosts.some((host) => host === "")) {
    throw new Error(
      "CODECITY_ALLOWED_HOSTS must be a comma-separated list of hostnames.",
    );
  }
  return hosts;
}

export function environmentAllowedGitOrigins(
  value: string | undefined,
): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const origins = value.split(",").map((origin) => origin.trim());
  if (origins.some((origin) => origin === "")) {
    throw new Error(
      "CODECITY_ALLOWED_GIT_ORIGINS must be a comma-separated list of exact HTTPS or SSH origins.",
    );
  }
  return origins;
}

export function environmentWindowsGitWorkspaceTrust(
  value: string | undefined,
): boolean {
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  throw new Error(
    "CODECITY_TRUST_WINDOWS_GIT_WORKSPACE must be exactly 1 when enabled.",
  );
}

export function environmentAuthorizationTokenFile(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== value.trim()) {
    throw new Error(
      "CODECITY_AUTH_TOKEN_FILE must not contain surrounding whitespace.",
    );
  }
  return value;
}

export function environmentPublicOrigin(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== value.trim()) {
    throw new Error(
      "CODECITY_PUBLIC_ORIGIN must not contain surrounding whitespace.",
    );
  }
  return value;
}

export function environmentWindowsAuthTokenFileTrust(
  value: string | undefined,
): boolean {
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  throw new Error(
    "CODECITY_TRUST_WINDOWS_AUTH_TOKEN_FILE must be exactly 1 when enabled.",
  );
}

export function environmentCredentialProfilesFile(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== value.trim()) {
    throw new Error(
      "CODECITY_CREDENTIAL_PROFILES_FILE must not contain surrounding whitespace.",
    );
  }
  return value;
}

export function environmentWindowsCredentialFilesTrust(
  value: string | undefined,
): boolean {
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  throw new Error(
    "CODECITY_TRUST_WINDOWS_CREDENTIAL_FILES must be exactly 1 when enabled.",
  );
}

export function environmentSourceRetention(
  value: string | undefined,
): "retain" | "disabled" {
  if (value === undefined || value === "" || value === "disabled") {
    return "disabled";
  }
  if (value === "retain") return "retain";
  throw new Error(
    "CODECITY_SOURCE_RETENTION must be exactly retain or disabled.",
  );
}

export function environmentEditorUrlTemplate(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== value.trim()) {
    throw new Error(
      "CODECITY_EDITOR_URL_TEMPLATE must not contain surrounding whitespace.",
    );
  }
  return value;
}

/**
 * Parses the deliberately small v1 administrator contract. A secret is named
 * by `authorizationEnv`; the JSON itself never contains a credential.
 */
export function environmentAiGuidanceConfiguration(
  value: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): AiGuidanceConfiguration | undefined {
  if (value === undefined || value === "") return undefined;
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new Error("CODECITY_AI_GUIDANCE_CONFIG must be valid JSON."); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("CODECITY_AI_GUIDANCE_CONFIG must be an object.");
  const object = raw as Record<string, unknown>;
  if (object["version"] !== AI_GUIDANCE_CONFIG_VERSION || typeof object["enabled"] !== "boolean" || !Array.isArray(object["providers"])) throw new Error("CODECITY_AI_GUIDANCE_CONFIG must use version 1.");
  const allowed = new Set(["version", "enabled", "providers", "timeoutMs", "maximumSourceBytes"]);
  if (Object.keys(object).some((key) => !allowed.has(key))) throw new Error("CODECITY_AI_GUIDANCE_CONFIG has an unknown field.");
  const providers = object["providers"].map((rawProvider) => {
    if (rawProvider === null || typeof rawProvider !== "object" || Array.isArray(rawProvider)) throw new Error("AI provider configuration is invalid.");
    const provider = rawProvider as Record<string, unknown>;
    const providerAllowed = new Set(["id", "label", "endpoint", "authorizationEnv", "authorizationHeader"]);
    if (Object.keys(provider).some((key) => !providerAllowed.has(key)) || typeof provider["id"] !== "string" || typeof provider["label"] !== "string" || typeof provider["endpoint"] !== "string") throw new Error("AI provider configuration is invalid.");
    if (provider["authorizationEnv"] === undefined) return { id: provider["id"], label: provider["label"], endpoint: provider["endpoint"] };
    if (typeof provider["authorizationEnv"] !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(provider["authorizationEnv"]) || (provider["authorizationHeader"] !== undefined && typeof provider["authorizationHeader"] !== "string")) throw new Error("AI provider credential reference is invalid.");
    const secret = environment[provider["authorizationEnv"]];
    if (secret === undefined || secret.length === 0) throw new Error(`AI provider credential ${provider["authorizationEnv"]} is not configured.`);
    return { id: provider["id"], label: provider["label"], endpoint: provider["endpoint"], authorization: { header: (provider["authorizationHeader"] as string | undefined) ?? "Authorization", value: secret } };
  });
  return {
    version: AI_GUIDANCE_CONFIG_VERSION,
    enabled: object["enabled"],
    providers,
    ...(object["timeoutMs"] === undefined ? {} : { timeoutMs: object["timeoutMs"] as number }),
    ...(object["maximumSourceBytes"] === undefined ? {} : { maximumSourceBytes: object["maximumSourceBytes"] as number }),
  };
}

export async function runServer(): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const host = process.env["CODECITY_HOST"];
    const port = environmentPort(process.env["CODECITY_PORT"]);
    const allowedHosts = environmentAllowedHosts(
      process.env["CODECITY_ALLOWED_HOSTS"],
    );
    const allowedGitOrigins = environmentAllowedGitOrigins(
      process.env["CODECITY_ALLOWED_GIT_ORIGINS"],
    );
    const trustWindowsGitWorkspace = environmentWindowsGitWorkspaceTrust(
      process.env["CODECITY_TRUST_WINDOWS_GIT_WORKSPACE"],
    );
    const authorizationTokenFile = environmentAuthorizationTokenFile(
      process.env["CODECITY_AUTH_TOKEN_FILE"],
    );
    const publicOrigin = environmentPublicOrigin(
      process.env["CODECITY_PUBLIC_ORIGIN"],
    );
    const trustWindowsAuthTokenFile =
      environmentWindowsAuthTokenFileTrust(
        process.env["CODECITY_TRUST_WINDOWS_AUTH_TOKEN_FILE"],
      );
    const credentialProfilesFile = environmentCredentialProfilesFile(
      process.env["CODECITY_CREDENTIAL_PROFILES_FILE"],
    );
    const trustWindowsCredentialFiles =
      environmentWindowsCredentialFilesTrust(
        process.env["CODECITY_TRUST_WINDOWS_CREDENTIAL_FILES"],
      );
    const sourceRetention = environmentSourceRetention(
      process.env["CODECITY_SOURCE_RETENTION"],
    );
    const editorUrlTemplate = environmentEditorUrlTemplate(
      process.env["CODECITY_EDITOR_URL_TEMPLATE"],
    );
    const aiGuidance = environmentAiGuidanceConfiguration(
      process.env["CODECITY_AI_GUIDANCE_CONFIG"],
    );
    const server = await startCodeCityServer({
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
      ...(allowedHosts === undefined ? {} : { allowedHosts }),
      ...(allowedGitOrigins === undefined ? {} : { allowedGitOrigins }),
      trustWindowsGitWorkspace,
      authorization: {
        ...(authorizationTokenFile === undefined
          ? {}
          : { tokenFile: authorizationTokenFile }),
        ...(publicOrigin === undefined ? {} : { publicOrigin }),
        trustWindowsTokenFile: trustWindowsAuthTokenFile,
      },
      credentialProfiles: {
        ...(credentialProfilesFile === undefined
          ? {}
          : { profilesFile: credentialProfilesFile }),
        trustWindowsCredentialFiles,
      },
      sourceRetention,
      ...(aiGuidance === undefined ? {} : { aiGuidance }),
      ...(editorUrlTemplate === undefined
        ? {}
        : { editorUrlTemplate }),
      dataDirectory: path.resolve(
        process.env["CODECITY_DATA_DIR"] ?? "data",
      ),
      signal: controller.signal,
    });
    process.stdout.write(`Code City is listening at ${server.url.href}\n`);
    await server.closed;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await runServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
