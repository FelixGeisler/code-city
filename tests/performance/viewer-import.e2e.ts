import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import type {
  GenericGitAnalysisResult,
  LocalAnalysisOptions,
  PublicGitHubAnalysisResult,
} from "../../packages/analyzer/src/index.js";
import type { CityModel } from "../../packages/core/src/model.js";
import type {
  RemoteImportDependencies,
} from "../../apps/server/src/remote-import.js";
import {
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../../apps/server/src/server.js";

let server: CodeCityServerHandle;
let testRoot: string;
let dataDirectory: string;
let accessToken: string;
let directoryFixture: string;
let zipFixture: string;
let cityModelFixture: CityModel;

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PUBLIC_GITHUB_URL = "https://github.com/code-city-e2e/public";
const PRIVATE_GITHUB_URL = "https://github.com/code-city-e2e/private";
const AZURE_DEVOPS_URL =
  "https://dev.azure.com/CodeCityE2E/Project/_git/Repository";
const GENERIC_GIT_URL =
  "https://git.example.test/group/repository.git";
const CANCELLATION_GIT_URL =
  "https://git.example.test/group/cancel.git";

interface RemoteInvocation {
  readonly kind: "github" | "git";
  readonly repositoryUrl: string;
  readonly ref?: string;
  readonly credentialProvider?: "basic" | "github";
  readonly title?: string;
  readonly version?: string;
  readonly maxRetainedFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly timeoutMs?: number;
}

const remoteInvocations: RemoteInvocation[] = [];

async function privateFile(
  file: string,
  contents: string,
): Promise<void> {
  await fs.writeFile(file, contents, { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
}

function modelForOptions(options?: LocalAnalysisOptions): CityModel {
  const title = options?.title;
  const version = options?.version;
  if (title === undefined) return cityModelFixture;
  return {
    ...cityModelFixture,
    identity: {
      title,
      ...(version === undefined ? {} : { version }),
    },
  };
}

function invocationOptions(
  options?: LocalAnalysisOptions,
): Omit<RemoteInvocation, "kind" | "repositoryUrl" | "ref" | "credentialProvider"> {
  return {
    ...(options?.title === undefined ? {} : { title: options.title }),
    ...(options?.version === undefined
      ? {}
      : { version: options.version }),
    ...(options?.maxRetainedFiles === undefined
      ? {}
      : { maxRetainedFiles: options.maxRetainedFiles }),
    ...(options?.maxFileBytes === undefined
      ? {}
      : { maxFileBytes: options.maxFileBytes }),
    ...(options?.maxTotalBytes === undefined
      ? {}
      : { maxTotalBytes: options.maxTotalBytes }),
    ...(options?.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
}

const githubAnalyzer: NonNullable<
  RemoteImportDependencies["analyzePublicGitHubRepository"]
> = async (
  request,
  options,
  dependencies,
): Promise<PublicGitHubAnalysisResult> => {
  const parsed = new URL(request.repositoryUrl);
  const [owner = "code-city-e2e", repository = "repository"] =
    parsed.pathname.split("/").filter(Boolean);
  remoteInvocations.push({
    kind: "github",
    repositoryUrl: request.repositoryUrl,
    ...(request.ref === undefined ? {} : { ref: request.ref }),
    ...(dependencies?.credentialProvider === undefined
      ? {}
      : {
          credentialProvider:
            dependencies.credentialProvider.provider,
        }),
    ...invocationOptions(options),
  });
  return {
    owner,
    repository,
    canonicalRepositoryUrl: request.repositoryUrl,
    commitSha: COMMIT,
    model: modelForOptions(options),
  };
};

const gitAnalyzer: NonNullable<
  RemoteImportDependencies["analyzeGenericGitRepository"]
> = async (
  request,
  options,
  dependencies,
): Promise<GenericGitAnalysisResult> => {
  remoteInvocations.push({
    kind: "git",
    repositoryUrl: request.repositoryUrl,
    ...(request.ref === undefined ? {} : { ref: request.ref }),
    ...(dependencies?.credentialProvider === undefined
      ? {}
      : {
          credentialProvider:
            dependencies.credentialProvider.provider,
        }),
    ...invocationOptions(options),
  });
  if (request.repositoryUrl === CANCELLATION_GIT_URL) {
    const signal = options?.signal;
    if (signal === undefined) {
      throw new Error("The cancellation import did not receive a signal.");
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    signal.throwIfAborted();
  }
  return {
    repository: "repository",
    commitSha: COMMIT,
    transport: "https",
    model: modelForOptions(options),
  };
};

async function availableLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("Loopback port probe did not bind.");
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

test.beforeAll(async () => {
  testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-viewer-import-"),
  );
  dataDirectory = path.join(testRoot, "data");
  directoryFixture = path.join(testRoot, "directory-project");
  await fs.mkdir(path.join(directoryFixture, "src"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(directoryFixture, "package.json"),
    JSON.stringify({ name: "directory-project", version: "1.0.0" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(directoryFixture, "src", "index.ts"),
    "export function directoryValue(input: boolean): number {\n  return input ? 1 : 0;\n}\n",
    "utf8",
  );
  zipFixture = path.join(testRoot, "archive-project.zip");
  await fs.writeFile(
    zipFixture,
    zipSync({
      "archive-project/package.json": strToU8(
        JSON.stringify({
          name: "archive-project",
          version: "1.0.0",
        }),
      ),
      "archive-project/src/index.ts": strToU8(
        "export const archiveValue = 42;\n",
      ),
    }),
  );
  cityModelFixture = JSON.parse(
    await fs.readFile(
      path.resolve("examples/demo-city.json"),
      "utf8",
    ),
  ) as CityModel;

  accessToken = randomBytes(32).toString("base64url");
  const tokenFile = path.join(testRoot, "access-token");
  await privateFile(tokenFile, `${accessToken}\n`);
  const credentialDirectory = path.join(testRoot, "credentials");
  await fs.mkdir(credentialDirectory, { mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(credentialDirectory, 0o700);
  }
  await privateFile(
    path.join(credentialDirectory, "github.secret"),
    "e2e-github-placeholder-credential\n",
  );
  await privateFile(
    path.join(credentialDirectory, "git.secret"),
    "e2e-git-placeholder-credential\n",
  );
  const profilesFile = path.join(
    credentialDirectory,
    "profiles.json",
  );
  await privateFile(
    profilesFile,
    JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "e2e-github",
          label: "E2E GitHub profile",
          provider: "github",
          repositories: [PRIVATE_GITHUB_URL],
          authentication: {
            kind: "bearer",
            secretFile: "github.secret",
          },
        },
        {
          id: "e2e-azure",
          label: "E2E Azure DevOps profile",
          provider: "azure-devops",
          repositories: [AZURE_DEVOPS_URL],
          authentication: {
            kind: "basic",
            username: "e2e-azure-user",
            secretFile: "git.secret",
          },
        },
        {
          id: "e2e-generic",
          label: "E2E Generic Git profile",
          provider: "generic-https",
          repositories: [GENERIC_GIT_URL, CANCELLATION_GIT_URL],
          authentication: {
            kind: "basic",
            username: "e2e-git-user",
            secretFile: "git.secret",
          },
        },
      ],
    }),
  );

  const port = await availableLoopbackPort();
  server = await startCodeCityServer({
    host: "127.0.0.1",
    port,
    dataDirectory,
    viewerRoot: path.resolve("build/viewer"),
    authorization: {
      tokenFile,
      publicOrigin: `http://127.0.0.1:${port}`,
      ...(process.platform === "win32"
        ? { trustWindowsTokenFile: true }
        : {}),
    },
    credentialProfiles: {
      profilesFile,
      ...(process.platform === "win32"
        ? { trustWindowsCredentialFiles: true }
        : {}),
    },
    allowedGitOrigins: [
      "https://dev.azure.com",
      "https://git.example.test",
    ],
    trustWindowsGitWorkspace: true,
    importDependencies: {
      analyzePublicGitHubRepository: githubAnalyzer,
      analyzeGenericGitRepository: gitAnalyzer,
    },
  });
});

test.afterAll(async () => {
  await server.close();
  await fs.rm(testRoot, { recursive: true, force: true });
});

async function openAuthenticatedWizard(page: Page): Promise<void> {
  await page.goto(server.url.href, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import project" }).click();
  await page.locator("#project-import-token").fill(accessToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#project-import-auth")).toBeHidden();
  await expect(page.locator("#project-import-source-title")).toBeVisible();
}

async function openNextImport(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Import project" }).click();
  await expect(page.locator("#project-import-source-title")).toBeVisible();
}

async function chooseSource(
  page: Page,
  source:
    | "directory"
    | "zip"
    | "github-public"
    | "github-authenticated"
    | "azure-devops"
    | "git",
): Promise<void> {
  await page
    .locator(`input[name="project-import-source"][value="${source}"]`)
    .check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-details-title")).toBeVisible();
}

async function continueToOptions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-options-title")).toBeVisible();
}

async function continueToReview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-progress-title")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start import" }),
  ).toBeVisible();
}

async function startAndWaitForImportedCity(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(page.locator("#project-import-dialog")).toBeHidden({
    timeout: 30_000,
  });
  const jobId = await page.evaluate(() =>
    localStorage.getItem("code-city.last-import-job.v1"),
  );
  expect(jobId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(server.jobs.get(jobId!)?.state).toBe("completed");
  return jobId!;
}

function lastRemoteInvocation(
  repositoryUrl: string,
): RemoteInvocation | undefined {
  return [...remoteInvocations]
    .reverse()
    .find((invocation) => invocation.repositoryUrl === repositoryUrl);
}

test("uploads, opens, and restores a city model through the real browser API", async ({
  page,
}) => {
  await page.goto(server.url.href, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Import project" }).click();
  await page.locator("#project-import-token").fill(accessToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#project-import-auth")).toBeHidden();
  await expect(page.locator("#project-import-token")).toHaveValue("");
  await page
    .locator('input[name="project-import-source"][value="city-model"]')
    .check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-details-title")).toBeFocused();
  await expect(page.locator("#project-import-live-status")).toContainText(
    "Step 2 of 4: Source details.",
  );
  await page
    .locator("#project-import-model")
    .setInputFiles(path.resolve("examples/demo-city.json"));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-progress-title")).toBeFocused();
  await expect(page.locator("#project-import-live-status")).toContainText(
    "Step 4 of 4: Import project.",
  );
  await expect(
    page.getByRole("button", { name: "Start import" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start import" }).click();

  await expect(page.locator("#project-import-dialog")).toBeHidden({
    timeout: 30_000,
  });
  await expect(page.locator("#model-name")).toHaveAttribute(
    "title",
    "Source: Imported project",
  );
  await expect(page.locator("#project-import-model")).toHaveValue("");
  await expect(page.locator("#project-import-repository-url")).toHaveValue(
    "",
  );

  const stored = await page.evaluate(() => ({
    keys: Object.keys(localStorage),
    jobId: localStorage.getItem("code-city.last-import-job.v1"),
    sessionKeys: Object.keys(sessionStorage),
  }));
  expect(stored.keys).toEqual(["code-city.last-import-job.v1"]);
  expect(stored.jobId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(stored.sessionKeys).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe("");
  expect(await page.content()).not.toContain(accessToken);
  expect(server.jobs.get(stored.jobId!)?.state).toBe("completed");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#model-name")).toHaveAttribute(
    "title",
    "Source: Imported project",
    { timeout: 30_000 },
  );
  await expect(page.getByRole("alert")).toBeHidden();

  await page.getByRole("button", { name: "Import project" }).click();
  await expect(
    page.getByRole("button", { name: "Sign out" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#project-import-auth")).toBeVisible();
  await expect(page.locator("#model-name")).toHaveAttribute(
    "title",
    "Source: Built-in demo",
  );
  expect(
    await page.evaluate(() =>
      localStorage.getItem("code-city.last-import-job.v1"),
    ),
  ).toBeNull();
});

test("imports a browser directory and repository ZIP with identity and analysis options", async ({
  page,
}) => {
  await openAuthenticatedWizard(page);

  await chooseSource(page, "directory");
  await page
    .locator("#project-import-directory")
    .setInputFiles(directoryFixture);
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Directory import E2E");
  await page
    .locator("#project-import-identity-version")
    .fill("directory-v1");
  await page.locator("#project-import-max-files").fill("75");
  await page.locator("#project-import-max-file-mib").fill("2");
  await page.locator("#project-import-max-total-mib").fill("1");
  await page.locator("#project-import-timeout-seconds").fill("30");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.locator("#project-import-error-analysis"),
  ).toContainText("Per-file MiB must not exceed total MiB.");
  await expect(page.locator("#project-import-max-files")).toBeFocused();
  await page.locator("#project-import-max-total-mib").fill("2");
  await continueToReview(page);
  await expect(page.locator("#project-import-review-source")).toHaveText(
    "Local directory",
  );
  await expect(page.locator("#project-import-review-input")).toHaveText(
    path.basename(directoryFixture),
  );
  await expect(page.locator("#project-import-review-revision")).toHaveText(
    "Uploaded content",
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText(
    "Directory import E2E",
  );
  await expect(page.locator("#status")).toContainText("directory-v1");

  await openNextImport(page);
  await chooseSource(page, "zip");
  await page.locator("#project-import-zip").setInputFiles(zipFixture);
  await expect(page.locator("#project-import-zip-name")).toHaveValue(
    "archive-project",
  );
  await page.locator("#project-import-zip-root").selectOption(
    "archive-root",
  );
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("ZIP import E2E");
  await page
    .locator("#project-import-identity-version")
    .fill("zip-v1");
  await continueToReview(page);
  await expect(page.locator("#project-import-review-source")).toHaveText(
    "ZIP archive",
  );
  await expect(page.locator("#project-import-review-input")).toHaveText(
    path.basename(zipFixture),
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText("ZIP import E2E");
  await expect(page.locator("#status")).toContainText("zip-v1");
});

test("accepts all remote sources, revisions, profiles, and server field corrections without network access", async ({
  page,
}) => {
  remoteInvocations.length = 0;
  await openAuthenticatedWizard(page);

  await chooseSource(page, "github-public");
  const historyToggle = page.locator("#project-import-history-enabled");
  await expect(historyToggle).toBeVisible();
  await expect(historyToggle).not.toBeChecked();
  await expect(
    page.locator("#project-import-history-options"),
  ).toBeHidden();
  await historyToggle.check();
  await expect(
    page.locator("#project-import-history-options"),
  ).toBeVisible();
  await page
    .locator("#project-import-history-mode")
    .selectOption("date-range");
  await expect(page.locator("#project-import-history-from")).toBeVisible();
  await page
    .locator("#project-import-history-mode")
    .selectOption("tag-range");
  await expect(
    page.locator("#project-import-history-oldest-tag"),
  ).toBeVisible();
  await historyToggle.uncheck();
  await page
    .locator("#project-import-repository-url")
    .fill(`${PUBLIC_GITHUB_URL}/tree/main`);
  await page
    .locator('input[name="project-import-revision"][value="branch"]')
    .check();
  await page.locator("#project-import-revision-value").fill("feature/e2e");
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Public GitHub E2E");
  await page
    .locator("#project-import-identity-version")
    .fill("public-v1");
  await page.locator("#project-import-max-files").fill("321");
  await page.locator("#project-import-max-file-mib").fill("1");
  await page.locator("#project-import-max-total-mib").fill("2");
  await page.locator("#project-import-timeout-seconds").fill("17");
  await continueToReview(page);
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(
    page.locator("#project-import-error-repository-url"),
  ).toContainText(
    "Must be a canonical anonymous https://github.com/owner/repository URL.",
  );
  await expect(
    page.locator("#project-import-repository-url"),
  ).toBeFocused();
  await expect(
    page.locator("#project-import-repository-url"),
  ).toHaveAttribute("aria-invalid", "true");

  await page
    .locator("#project-import-repository-url")
    .fill(PUBLIC_GITHUB_URL);
  await continueToOptions(page);
  await continueToReview(page);
  await expect(page.locator("#project-import-review-revision")).toHaveText(
    "branch: feature/e2e",
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText(
    "Public GitHub E2E",
  );
  expect(lastRemoteInvocation(PUBLIC_GITHUB_URL)).toMatchObject({
    kind: "github",
    repositoryUrl: PUBLIC_GITHUB_URL,
    ref: "heads/feature/e2e",
    title: "Public GitHub E2E",
    version: "public-v1",
    maxRetainedFiles: 321,
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
    timeoutMs: 17_000,
  });

  await openNextImport(page);
  await chooseSource(page, "github-authenticated");
  await page
    .locator("#project-import-repository-url")
    .fill(PRIVATE_GITHUB_URL);
  await page
    .locator('input[name="project-import-revision"][value="commit"]')
    .check();
  await page.locator("#project-import-revision-value").fill("abc");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#project-import-error-profile")).toContainText(
    "Choose a configured GitHub profile.",
  );
  await expect(page.locator("#project-import-error-revision")).toContainText(
    "Enter an exact 40-character commit SHA.",
  );
  await page
    .locator("#project-import-profile")
    .selectOption({ label: "E2E GitHub profile" });
  await page.locator("#project-import-revision-value").fill(COMMIT);
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Authenticated GitHub E2E");
  await continueToReview(page);
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText(
    "Authenticated GitHub E2E",
  );
  expect(lastRemoteInvocation(PRIVATE_GITHUB_URL)).toMatchObject({
    kind: "github",
    repositoryUrl: PRIVATE_GITHUB_URL,
    ref: COMMIT,
    credentialProvider: "github",
  });

  await openNextImport(page);
  await chooseSource(page, "azure-devops");
  await page
    .locator("#project-import-repository-url")
    .fill(AZURE_DEVOPS_URL);
  await page
    .locator("#project-import-profile")
    .selectOption({ label: "E2E Azure DevOps profile" });
  await page
    .locator('input[name="project-import-revision"][value="tag"]')
    .check();
  await page.locator("#project-import-revision-value").fill("release/v1");
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Azure DevOps E2E");
  await continueToReview(page);
  await expect(page.locator("#project-import-review-revision")).toHaveText(
    "tag: release/v1",
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText("Azure DevOps E2E");
  expect(lastRemoteInvocation(AZURE_DEVOPS_URL)).toMatchObject({
    kind: "git",
    repositoryUrl: AZURE_DEVOPS_URL,
    ref: "refs/tags/release/v1",
    credentialProvider: "basic",
  });

  await openNextImport(page);
  await chooseSource(page, "git");
  await page
    .locator("#project-import-repository-url")
    .fill(GENERIC_GIT_URL);
  await page
    .locator("#project-import-profile")
    .selectOption({ label: "E2E Generic Git profile" });
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Generic Git E2E");
  await continueToReview(page);
  await expect(page.locator("#project-import-review-revision")).toHaveText(
    "Repository default",
  );
  await startAndWaitForImportedCity(page);
  await expect(page.locator("#model-name")).toHaveText("Generic Git E2E");
  expect(lastRemoteInvocation(GENERIC_GIT_URL)).toMatchObject({
    kind: "git",
    repositoryUrl: GENERIC_GIT_URL,
    credentialProvider: "basic",
  });
  expect(lastRemoteInvocation(GENERIC_GIT_URL)).not.toHaveProperty("ref");
});

test("cancels an accepted remote import and removes its private staging data", async ({
  page,
}) => {
  await openAuthenticatedWizard(page);
  await chooseSource(page, "git");
  await page
    .locator("#project-import-repository-url")
    .fill(CANCELLATION_GIT_URL);
  await page
    .locator("#project-import-profile")
    .selectOption({ label: "E2E Generic Git profile" });
  await page
    .locator('input[name="project-import-revision"][value="branch"]')
    .check();
  await page.locator("#project-import-revision-value").fill("cancel-e2e");
  await continueToOptions(page);
  await page
    .locator("#project-import-identity-title")
    .fill("Sensitive cancellation title");
  await continueToReview(page);
  await page.getByRole("button", { name: "Start import" }).click();
  await expect(page.getByRole("button", { name: "Cancel import" }))
    .toBeVisible({ timeout: 15_000 });
  await expect.poll(
    () => lastRemoteInvocation(CANCELLATION_GIT_URL),
  ).toBeDefined();
  const jobId = await page.evaluate(() =>
    localStorage.getItem("code-city.last-import-job.v1"),
  );
  expect(jobId).not.toBeNull();
  await expect(
    page.locator("#project-import-repository-url"),
  ).toHaveValue("");
  await expect(
    page.locator("#project-import-identity-title"),
  ).toHaveValue("");

  await page.getByRole("button", { name: "Cancel import" }).click();
  await expect(page.locator("#project-import-status")).toHaveText(
    "Import cancelled",
    { timeout: 15_000 },
  );
  await expect.poll(() => server.jobs.get(jobId!)?.state).toBe(
    "cancelled",
  );
  await expect.poll(async () =>
    fs.readdir(path.join(dataDirectory, "tmp", "imports")),
  ).toEqual([]);
  expect(await server.artifacts.statCityModel(jobId!)).toBeUndefined();
  expect(lastRemoteInvocation(CANCELLATION_GIT_URL)).toMatchObject({
    kind: "git",
    repositoryUrl: CANCELLATION_GIT_URL,
    ref: "refs/heads/cancel-e2e",
    credentialProvider: "basic",
  });
});
