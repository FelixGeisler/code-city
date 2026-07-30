# Code City

<img src="apps/viewer/src/code-city-icon.svg" width="64" height="64" alt="Code City icon">

Code City turns a software repository into:

- an interactive 3D city that can be explored in a web browser; and
- a printable multi-part 3MF or single-material STL model.

The CLI supports public GitHub repositories, generic Git remotes such as Azure
DevOps Server, and local checkouts that can be analyzed fully offline.

For a self-hosted network deployment, build and start the Raspberry Pi/AMD64
container:

```powershell
docker compose up --build
```

Then open `http://<server-address>:8080`. The container serves the viewer and
versioned API from one process, runs as a non-root user, and keeps persistent
job state in the `code-city-data` Docker volume. No external database, queue,
or cloud service is required. This first deployment has no authentication, so
expose it only on a trusted private network, not directly on the public
Internet. Numeric IP addresses and `localhost` are accepted by default. To use
a DNS name, set `CODECITY_ALLOWED_HOSTS` to a comma-separated allowlist before
starting Compose, for example `raspberrypi.local,codecity.lan`.

`POST /api/v1/imports` queues anonymous public-GitHub or Generic Git analysis
directly through the server API. Requests are bounded JSON and must include
`X-Code-City-Request: 1`; they return a persistent job URL, and a completed job
owns one immutable `city-model.json` artifact. Repository URLs, refs,
credentials, source bytes, diagnostics, and temporary paths are not written to
job records.

Browser clients can also reserve a one-use raw upload with
`POST /api/v1/imports/uploads`, then `PUT` either an existing
`city-model.json` (`application/json`) or one repository ZIP
(`application/zip`) to the returned URL. The reservation declares the exact
byte length; the PUT requires the same `Content-Length`, rejects transfer and
content encoding, and becomes a persistent import job only after the private
staged file is complete. Repository ZIP metadata selects either one common
top-level directory or paths already relative to the archive root. This is the
server API for a later browser directory/ZIP wizard; multipart uploads and
browser-supplied filenames are deliberately not accepted.

At most four upload reservations and 256 MiB of staged upload data exist at
once. City models are capped at 128 MiB, ZIPs at 64 MiB, unused reservations
expire after five minutes, and each upload has 30-second idle and ten-minute
total deadlines. Reservation expiry, disconnect, cancellation, job failure,
shutdown, and restart remove private staging data. Upload endpoints are also
unauthenticated in this initial deployment, so the trusted-network requirement
applies to them.

On Windows/IIS, uploads and published artifacts require a service-private
`CODECITY_DATA_DIR` even when Generic Git remains disabled. Restrict the data
directory and inherited children to the service identity and trusted
administrators, and protect its directory entry and canonical ancestors from
untrusted rename, delete, and delete-child access. Create-exclusive files and
portable fixed-path/handle identity checks remain enforced, but Node cannot
establish or prove those Windows ACL properties.

Generic Git is disabled by default because it runs Git as the server identity.
Enable only exact outbound origins with `CODECITY_ALLOWED_GIT_ORIGINS`, for
example `https://dev.azure.example,ssh://git.example:22`. Scheme and effective
port are significant; wildcards are not accepted. scp-style remotes use the
matching `ssh://host:22` origin. Explicitly allow a private or loopback origin
only when reaching it is intended.

The origin list is egress control, not per-repository or inbound authorization:
every unauthenticated Code City network client can request any repository/user
at an enabled origin and invoke the service account's ambient credential
helper, SSH agent/configuration, and enterprise CAs. Enable it only on a network
where every client is authorized, and use a least-privileged service identity.
On Windows/IIS, enabled origins also require
`CODECITY_TRUST_WINDOWS_GIT_WORKSPACE=1`. That flag attests that the data/import
workspace ACL and inherited child ACLs are limited to the service identity and
trusted administrators and that canonical ancestors prevent untrusted rename,
delete, and delete-child access; Code City cannot verify or establish those ACL
properties.

## Product idea

| Code concept | City representation |
| --- | --- |
| Repository | City |
| Package or directory | District |
| Source file | Building |
| Lines of code | Building footprint |
| Code complexity | Building height |
| Dependencies | Directed, weighted routes |
| Churn or maintenance risk | Color or material |

The browser and print outputs are generated from the same versioned
`city-model.json`, so the physical model corresponds to the city visible on
screen. Printer profiles map semantic groups onto any positive number of
configured tools or material inputs; five is not a core limit. A printable
identity panel carries the city name, version, and optional SVG/PNG logo
reference.

## Current development slice

```powershell
# Analyze one or more local roots without Git or network access
npm run cli -- analyze C:\Code\RepoA C:\Code\RepoB `
  --output build\city-model.json `
  --title "Product City" `
  --version "1.0.0"

# Analyze an anonymous public GitHub snapshot at one immutable commit
npm run cli -- analyze-github https://github.com/owner/repository `
  --ref main `
  --output build\github-city-model.json

# Analyze one advertised branch, tag, or exact commit through installed Git.
# On Windows, the trusted parent must already exist with the ACL described below.
npm run cli -- analyze-git https://dev.azure.example/Collection/Project/_git/Repo `
  --ref main `
  --trusted-workspace-parent C:\CodeCity\presecured-git-workspaces `
  --output build\remote-city-model.json

# Run the browser viewer
npm run viewer:dev

# Build and open a local repository through the bundled production viewer
npm run viewer:build
npm run cli -- open C:\Code\RepoA

# Export the connected five-part Demo for a Prusa XL
npm run print:demo

# Export the profile calibration plate and measurement manifest
npm run print:calibration

# Export another model through the same printer-general path
npm run cli -- export `
  --model examples\demo-city.json `
  --profile profiles\prusa-xl-5t.json `
  --format stl `
  --scale 3 `
  --labels auto `
  --routes auto `
  --legend build\print\code-city-demo.legend.json `
  --output build\print\code-city-demo.stl
```

The viewer accepts a `city-model.json` through **Open model**. **Print plates**
selects a generic, Prusa XL, or local custom printer profile, previews the exact
exporter layout, and downloads direct 3MF/STL or a deterministic multi-plate ZIP.
Generation runs locally in a cancellable worker; no model or profile is uploaded.
**Prepare calibration** downloads a profile-only test plate and measurement
manifest.

C# is analyzed by the bundled, syntax-only Roslyn helper. TypeScript and
JavaScript use the pinned compiler API. Neither analyzer restores, builds, runs
plugins, or executes repository content.

`analyze-github` accepts canonical `https://github.com/owner/repository` URLs
and normalizes an optional `.git` suffix. It resolves a public ref through
GitHub's anonymous API and downloads the matching commit archive with strict
size, path, and time limits. It sends no credentials and retains no archive,
source checkout, or derived cache; every run is fresh.

`analyze-git` accepts validated HTTPS, SSH, or scp-style remotes. It uses the
installed Git client and the user's existing credential helper, SSH agent, and
certificate configuration without storing or printing credentials. It fetches
one advertised ref into a temporary bare repository, archives one verified
commit, removes the repository, and enters the same bounded snapshot pipeline.
On Windows, `--trusted-workspace-parent` is required and names an existing
pre-secured private directory; the option is a trust assertion, not an ACL
configuration command. The service identity must exclusively control the
parent and inherited child ACLs so untrusted identities cannot read, write, or
create workspace content. The containing directory and canonical ancestor
entries must prevent untrusted rename, delete, and delete-child operations on
the protected path entries; those ancestors may otherwise remain readable or
traversable. Code City never claims that `chmod` establishes Windows privacy.
On POSIX, an explicitly configured parent must be process-owned mode `0700`;
the default OS temporary directory is accepted only when stable filesystem
identities and protected canonical ancestry (including valid sticky-directory
semantics) can be verified.
For Azure Pipelines, prefer `checkout: self` with `persistCredentials: false`
and analyze `$(Build.SourcesDirectory)` locally.

The Demo imports into PrusaSlicer with aligned tool parts. `--routes auto`
prints capped, aggregated district dependencies; routes default to `off`. The
private JSON legend maps printed codes to repository-relative paths. Oversized
cities use profile-safe `--fit scale` or complete-district `--fit tile`;
arbitrary fonts, custom logos, and slicer settings remain separate.

## Local product flow

`codecity open` accepts one or more local roots and serves only on
`127.0.0.1`; it prints the URL without launching a browser.

Architecture documentation uses Antora and the concise arc42 structure. It is
published at
<https://felixgeisler.github.io/code-city/>.

## Development

The supported local toolchain is **Node.js 24.x**, **npm 11.6.2**, and the
**.NET SDK 10.0.302** used to build the trusted Roslyn helper. The repository
pins these versions; use the committed `package-lock.json` through `npm ci`.

```powershell
node --version # must be v24.x
npm --version  # must be 11.6.2
dotnet --version # must be 10.0.302
npm ci
npm run verify
```

After a production build, the same server can run without Docker:

```powershell
$env:CODECITY_DATA_DIR = "C:\CodeCityData"
$env:CODECITY_HOST = "0.0.0.0"
$env:CODECITY_PORT = "3000"
$env:CODECITY_ALLOWED_HOSTS = "codecity.lan"
$env:CODECITY_ALLOWED_GIT_ORIGINS = "https://dev.azure.example"
# Windows only, after provisioning and auditing the data-directory ACL:
$env:CODECITY_TRUST_WINDOWS_GIT_WORKSPACE = "1"
npm run server:start
```

`verify` runs the same sequence used by Linux and Windows CI: typecheck, tests,
the production build, and the Antora documentation build. CI bounds each
verification job to 20 minutes.

## Status

First executable vertical slice. The open-source license will be chosen before
the first public release.
