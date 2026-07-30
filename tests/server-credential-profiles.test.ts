import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  CredentialProfileRegistry,
  type CredentialProfileRegistryOptions,
} from "../apps/server/src/credential-profiles.js";
import {
  environmentCredentialProfilesFile,
  environmentWindowsCredentialFilesTrust,
} from "../apps/server/src/main.js";
import { parseRemoteImportRequest } from "../apps/server/src/remote-import.js";
import {
  startCodeCityServer,
  type CodeCityServerHandle,
} from "../apps/server/src/server.js";

const AUTHORIZATION_TOKEN = Buffer.alloc(32, 0x4a).toString("base64url");
const temporaryDirectories: string[] = [];
const servers: CodeCityServerHandle[] = [];

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface ManifestProfile {
  readonly id: string;
  readonly label: string;
  readonly provider: "github" | "azure-devops" | "generic-https";
  readonly repositories: readonly string[];
  readonly authentication:
    | {
        readonly kind: "bearer";
        readonly secretFile: string;
      }
    | {
        readonly kind: "basic";
        readonly username: string;
        readonly secretFile: string;
      };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "code-city-credential-profiles-"),
  );
  temporaryDirectories.push(directory);
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  return directory;
}

async function privateFile(
  filePath: string,
  contents: string | Buffer,
): Promise<void> {
  await fs.writeFile(filePath, contents, { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(filePath, 0o600);
}

async function credentialFixture(
  profiles: readonly ManifestProfile[],
  secrets: Readonly<Record<string, string | Buffer>> = {
    "shared.secret": "credential-secret\n",
  },
): Promise<{
  readonly root: string;
  readonly directory: string;
  readonly profilesFile: string;
}> {
  const root = await temporaryDirectory();
  const directory = path.join(root, "credentials");
  await fs.mkdir(directory, { mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  for (const [name, contents] of Object.entries(secrets)) {
    await privateFile(path.join(directory, name), contents);
  }
  const profilesFile = path.join(directory, "profiles.json");
  await privateFile(
    profilesFile,
    JSON.stringify({ version: 1, profiles }),
  );
  return { root, directory, profilesFile };
}

function registryOptions(
  profilesFile: string,
): CredentialProfileRegistryOptions {
  return {
    profilesFile,
    trustWindowsCredentialFiles: process.platform === "win32",
  };
}

function bearerProfile(
  id: string,
  provider: ManifestProfile["provider"],
  repositories: readonly string[],
): ManifestProfile {
  return {
    id,
    label: `${id} label`,
    provider,
    repositories,
    authentication: {
      kind: "bearer",
      secretFile: "shared.secret",
    },
  };
}

function request(
  url: URL,
  options: {
    readonly method?: string;
    readonly headers?: http.OutgoingHttpHeaders;
  } = {},
): Promise<ResponseSnapshot> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function serverFixture(
  profiles: readonly ManifestProfile[],
): Promise<{
  readonly server: CodeCityServerHandle;
  readonly profilesFile: string;
}> {
  const fixture = await credentialFixture(profiles);
  const viewerRoot = path.join(fixture.root, "viewer");
  await fs.mkdir(viewerRoot);
  await fs.writeFile(
    path.join(viewerRoot, "index.html"),
    "<!doctype html><title>Credential profiles</title>",
    "utf8",
  );
  const tokenFile = path.join(fixture.root, "authorization-token");
  await privateFile(tokenFile, `${AUTHORIZATION_TOKEN}\n`);
  const server = await startCodeCityServer({
    host: "127.0.0.1",
    port: 0,
    dataDirectory: path.join(fixture.root, "data"),
    viewerRoot,
    authorization: {
      tokenFile,
      publicOrigin: "https://codecity.test",
      trustWindowsTokenFile: process.platform === "win32",
    },
    credentialProfiles: registryOptions(fixture.profilesFile),
  });
  servers.push(server);
  return { server, profilesFile: fixture.profilesFile };
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("credential profile registry", () => {
  it("publishes only sorted discovery metadata and enforces provider-specific exact scopes", async () => {
    const fixture = await credentialFixture([
      bearerProfile(
        "github-profile",
        "github",
        ["https://github.com/Example/Repository"],
      ),
      {
        id: "azure-profile",
        label: "Azure label",
        provider: "azure-devops",
        repositories: [
          "https://dev.azure.com/Org/Project/_git/Repository",
          "https://dev.azure.com/Org/_git/ShortRepository",
          "https://org.visualstudio.com/Project/_git/LegacyRepository",
          "https://azure.example.test/prefix/Project/_git/OnPremRepository.git",
        ],
        authentication: {
          kind: "basic",
          username: "build-user",
          secretFile: "shared.secret",
        },
      },
      bearerProfile(
        "generic-profile",
        "generic-https",
        [
          "https://git.example.test/Group/Repository.git",
          "https://git.example.test/Group/repo%3Bvariant",
          "https://git.example.test/Group/e%CC%81",
        ],
      ),
    ]);
    const registry = await CredentialProfileRegistry.open(
      registryOptions(fixture.profilesFile),
    );

    expect(registry.capabilities()).toEqual([
      {
        id: "azure-profile",
        label: "Azure label",
        provider: "azure-devops",
      },
      {
        id: "generic-profile",
        label: "generic-profile label",
        provider: "generic-https",
      },
      {
        id: "github-profile",
        label: "github-profile label",
        provider: "github",
      },
    ]);
    const projection = JSON.stringify(registry.capabilities());
    expect(projection).not.toMatch(
      /secret|username|repository|shared\.secret/iu,
    );
    expect(
      registry.permits(
        "github-profile",
        "github",
        "https://github.com/example/REPOSITORY",
      ),
    ).toBe(true);
    expect(
      registry.permits(
        "github-profile",
        "github",
        "https://github.com/Example/Repository.git",
      ),
    ).toBe(false);
    expect(
      registry.permits(
        "generic-profile",
        "generic-https",
        "https://git.example.test/Group/Repository.git",
      ),
    ).toBe(true);
    expect(
      registry.permits(
        "generic-profile",
        "generic-https",
        "https://git.example.test/Group/Repository",
      ),
    ).toBe(false);
    expect(
      registry.permits(
        "generic-profile",
        "generic-https",
        "https://git.example.test/Group/repo;variant",
      ),
    ).toBe(false);
    expect(
      registry.permits(
        "generic-profile",
        "generic-https",
        "https://git.example.test/Group/%C3%A9",
      ),
    ).toBe(false);
    expect(
      registry.permits(
        "azure-profile",
        "azure-devops",
        "https://dev.azure.com/Org/Project/_git/Repository",
      ),
    ).toBe(true);
    expect(
      registry.permits(
        "azure-profile",
        "azure-devops",
        "https://dev.azure.com/org/project/_git/repository",
      ),
    ).toBe(false);

    registry.close();
    expect(registry.capabilities()).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it("rejects non-canonical authorities, unsafe paths, and invalid Azure shapes", async () => {
    const repositories = [
      "https://git..example.test/owner/repository",
      `https://${"a".repeat(64)}.example.test/owner/repository`,
      "https://GIT.example.test/owner/repository",
      "https://git.example.test:443/owner/repository",
      "https://git.example.test/owner/%2E",
      "https://git.example.test/owner/repo%2Fremainder",
      "https://git.example.test/owner/repo%3bvariant",
      "https://dev.azure.com/org/project/repository",
      "https://dev.azure.com/org/%5Fgit/_git/repository",
      "https://dev.azure.com/prefix/org/project/_git/repository",
    ];
    for (const [index, repository] of repositories.entries()) {
      const provider = index < 7 ? "generic-https" : "azure-devops";
      const fixture = await credentialFixture([
        bearerProfile("invalid-profile", provider, [repository]),
      ]);
      await expect(
        CredentialProfileRegistry.open(
          registryOptions(fixture.profilesFile),
        ),
      ).rejects.toThrow(/canonical|repository|hostname|path/iu);
    }
  });

  it("rejects duplicate and unknown manifest data without exposing secrets", async () => {
    const duplicate = await credentialFixture([
      bearerProfile(
        "duplicate-profile",
        "github",
        [
          "https://github.com/Example/Repository",
          "https://github.com/example/repository",
        ],
      ),
    ]);
    await expect(
      CredentialProfileRegistry.open(
        registryOptions(duplicate.profilesFile),
      ),
    ).rejects.toThrow(/duplicate canonical repositories/iu);

    const unknown = await credentialFixture([
      {
        ...bearerProfile(
          "unknown-profile",
          "github",
          ["https://github.com/Example/Repository"],
        ),
        unexpected: "credential-secret",
      } as ManifestProfile,
    ]);
    await expect(
      CredentialProfileRegistry.open(
        registryOptions(unknown.profilesFile),
      ),
    ).rejects.toThrow(/unknown field/iu);

    for (const rawManifest of [
      '{"version":1,"version":1,"profiles":[]}',
      '{"version":1,"profiles":[{"id":"duplicate-id","\\u0069d":"duplicate-id","label":"Duplicate","provider":"github","repositories":["https://github.com/Example/Repository"],"authentication":{"kind":"bearer","secretFile":"missing.secret"}}]}',
    ]) {
      const duplicateMember = await credentialFixture([
        bearerProfile(
          "placeholder-profile",
          "github",
          ["https://github.com/Example/Repository"],
        ),
      ]);
      await privateFile(duplicateMember.profilesFile, rawManifest);
      await fs.rm(
        path.join(duplicateMember.directory, "shared.secret"),
      );
      await expect(
        CredentialProfileRegistry.open(
          registryOptions(duplicateMember.profilesFile),
        ),
      ).rejects.toThrow(/exact-shape JSON/iu);
    }
  });

  it("rejects hard links, symlinks, permissive modes, and unsafe secret text", async () => {
    const hardLink = await credentialFixture([
      bearerProfile(
        "hard-link-profile",
        "github",
        ["https://github.com/Example/Repository"],
      ),
    ]);
    const hardLinkTarget = path.join(hardLink.directory, "target.secret");
    await privateFile(hardLinkTarget, "credential-secret\n");
    await fs.rm(path.join(hardLink.directory, "shared.secret"));
    await fs.link(
      hardLinkTarget,
      path.join(hardLink.directory, "shared.secret"),
    );
    await expect(
      CredentialProfileRegistry.open(
        registryOptions(hardLink.profilesFile),
      ),
    ).rejects.toThrow(/private regular-file policy/iu);

    const manifestAlias = await credentialFixture([
      {
        ...bearerProfile(
          "manifest-alias-profile",
          "github",
          ["https://github.com/Example/Repository"],
        ),
        authentication: {
          kind: "bearer",
          secretFile: "manifest-alias",
        },
      },
    ]);
    await fs.link(
      manifestAlias.profilesFile,
      path.join(manifestAlias.directory, "manifest-alias"),
    );
    await expect(
      CredentialProfileRegistry.open(
        registryOptions(manifestAlias.profilesFile),
      ),
    ).rejects.toThrow(/private regular-file policy|manifest file/iu);

    if (process.platform !== "win32") {
      const symlink = await credentialFixture([
        bearerProfile(
          "symlink-profile",
          "github",
          ["https://github.com/Example/Repository"],
        ),
      ]);
      const target = path.join(symlink.directory, "target.secret");
      await privateFile(target, "credential-secret\n");
      await fs.rm(path.join(symlink.directory, "shared.secret"));
      await fs.symlink(
        target,
        path.join(symlink.directory, "shared.secret"),
        "file",
      );
      await expect(
        CredentialProfileRegistry.open(
          registryOptions(symlink.profilesFile),
        ),
      ).rejects.toThrow(/private regular-file policy/iu);

      const permissive = await credentialFixture([
        bearerProfile(
          "permissive-profile",
          "github",
          ["https://github.com/Example/Repository"],
        ),
      ]);
      await fs.chmod(
        path.join(permissive.directory, "shared.secret"),
        0o644,
      );
      await expect(
        CredentialProfileRegistry.open(
          registryOptions(permissive.profilesFile),
        ),
      ).rejects.toThrow(/0400 or 0600/iu);
    }

    for (const secret of ["credential\tsecret\n", "credential\u200bsecret\n"]) {
      const unsafe = await credentialFixture(
        [
          bearerProfile(
            "unsafe-secret-profile",
            "github",
            ["https://github.com/Example/Repository"],
          ),
        ],
        { "shared.secret": secret },
      );
      await expect(
        CredentialProfileRegistry.open(
          registryOptions(unsafe.profilesFile),
        ),
      ).rejects.toThrow(/one nonempty UTF-8 line/iu);
    }
  });

  it("is disabled by default and requires explicit Windows file trust", async () => {
    const empty = await CredentialProfileRegistry.open();
    expect(empty.configured).toBe(false);
    expect(empty.capabilities()).toEqual([]);

    const fixture = await credentialFixture([
      bearerProfile(
        "windows-profile",
        "github",
        ["https://github.com/Example/Repository"],
      ),
    ]);
    await expect(
      CredentialProfileRegistry.open({
        profilesFile: fixture.profilesFile,
        platform: "win32",
      }),
    ).rejects.toThrow(/Windows.*trust/iu);
    const trusted = await CredentialProfileRegistry.open({
      profilesFile: fixture.profilesFile,
      platform: "win32",
      trustWindowsCredentialFiles: true,
    });
    expect(trusted.size).toBe(1);
  });
});

describe("credential profile server integration", () => {
  it("serves an authenticated, cache-free, redacted GET and HEAD projection", async () => {
    const { server } = await serverFixture([
      bearerProfile(
        "github-profile",
        "github",
        ["https://github.com/Example/Repository"],
      ),
    ]);
    const url = new URL("/api/v1/imports/capabilities", server.url);

    const unauthorized = await request(url, {
      headers: { Host: "codecity.test" },
    });
    expect(unauthorized.status).toBe(401);

    const headers = {
      Authorization: `Bearer ${AUTHORIZATION_TOKEN}`,
      Host: "codecity.test",
    };
    const response = await request(url, { headers });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual({
      credentialProfiles: [
        {
          id: "github-profile",
          label: "github-profile label",
          provider: "github",
        },
      ],
    });

    const head = await request(url, { method: "HEAD", headers });
    expect(head.status).toBe(200);
    expect(head.headers["cache-control"]).toBe("no-store");
    expect(head.body).toBe("");

    const wrongMethod = await request(url, {
      method: "POST",
      headers,
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET, HEAD");
  });

  it("fails the inbound-auth prerequisite before profile-file access", async () => {
    const root = await temporaryDirectory();
    const viewerRoot = path.join(root, "viewer");
    await fs.mkdir(viewerRoot);
    await fs.writeFile(
      path.join(viewerRoot, "index.html"),
      "<!doctype html>",
      "utf8",
    );
    const missingProfiles = path.join(root, "missing", "profiles.json");
    await expect(
      startCodeCityServer({
        host: "127.0.0.1",
        port: 0,
        dataDirectory: path.join(root, "data"),
        viewerRoot,
        credentialProfiles: { profilesFile: missingProfiles },
      }),
    ).rejects.toThrow(
      /CODECITY_CREDENTIAL_PROFILES_FILE requires configured inbound authorization/u,
    );
    await expect(fs.stat(path.join(root, "data"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("parses profile environment controls strictly", () => {
    expect(environmentCredentialProfilesFile(undefined)).toBeUndefined();
    expect(environmentCredentialProfilesFile("")).toBeUndefined();
    expect(environmentCredentialProfilesFile("/private/profiles.json"))
      .toBe("/private/profiles.json");
    expect(() => environmentCredentialProfilesFile(" profiles.json"))
      .toThrow(/surrounding whitespace/u);
    expect(environmentWindowsCredentialFilesTrust(undefined)).toBe(false);
    expect(environmentWindowsCredentialFilesTrust("1")).toBe(true);
    expect(() => environmentWindowsCredentialFilesTrust("true"))
      .toThrow(/exactly 1/u);
  });

  it("does not add credential selection to the import contract", () => {
    expect(() =>
      parseRemoteImportRequest({
        source: {
          kind: "github",
          repositoryUrl: "https://github.com/Example/Repository",
          credentialProfileId: "github-profile",
        },
      }),
    ).toThrow("The import request is invalid.");
  });
});
