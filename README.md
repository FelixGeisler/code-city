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
or cloud service is required. Authorization is disabled by default, so expose
that trusted-network mode only on a private network, not directly on the public
Internet. Numeric IP addresses and `localhost` are accepted by default. To use
a DNS name, set `CODECITY_ALLOWED_HOSTS` to a comma-separated allowlist before
starting Compose, for example `raspberrypi.local,codecity.lan`.

`POST /api/v1/imports` queues anonymous public-GitHub, exact-scope credentialed
GitHub or HTTPS Git, or Generic Git analysis directly through the server API.
Requests are bounded JSON and must include
`X-Code-City-Request: 1`; they return a persistent job URL, and a completed job
owns one immutable `city-model.json` artifact. A history import atomically
publishes an additional immutable `evolution.json` artifact and returns its
URL, byte size, and SHA-256 digest in `job.result.evolution`.
Repository URLs, credential-profile selectors, secrets, requested symbolic
refs, source bytes, diagnostics, and temporary paths are not written to job
records. The resolved immutable commit SHA may become the generated model's
default version.

Browser clients can also reserve a one-use raw upload with
`POST /api/v1/imports/uploads`, then `PUT` either an existing
`city-model.json` (`application/json`) or one repository ZIP
(`application/zip`) to the returned URL. The reservation declares the exact
byte length; the PUT requires the same `Content-Length`, rejects transfer and
content encoding, and becomes a persistent import job only after the private
staged file is complete. Repository ZIP metadata selects either one common
top-level directory or paths already relative to the archive root. This is the
protocol used by the viewer's **Import project** wizard; multipart uploads and
browser-supplied filenames are deliberately not accepted by the server.

The wizard can package a browser-selected local directory, upload a ZIP or
existing city model, or queue public/private GitHub, Azure DevOps, HTTPS, SSH,
and scp-style Git imports. Remote imports support the default revision, a
branch, a tag, or one exact commit, plus optional city identity and bounded
analysis settings. They can also opt into a bounded first-parent history. The
recommended default follows the complete mainline from its first commit to the
selected revision and distributes at most 20 animation frames across that
span by elapsed time. These are representative snapshots: intermediate
commits are indexed as lightweight metadata, but their source is not analyzed.
Recent commit count, inclusive UTC date range, and two exact tag names remain
available as custom ranges.
Directory packaging runs in a cancellable browser worker,
keeps only analyzer inputs and ignore controls, rejects unsafe or colliding
portable paths, and produces a deterministic, size-bounded ZIP before making
an upload reservation. The server applies the same snapshot and analyzer
pipeline used by the CLI and remains authoritative for validation.

Import jobs report live progress, can be cancelled explicitly, and open their
generated city automatically. The browser persists only the opaque job UUID,
so a queued, running, or completed import can be recovered after refresh. It
does not persist the source URL, selected credential profile, revision, token,
file metadata, repository bytes, or generated model. Closing the dialog or
browser leaves an accepted server job running; **Cancel import** requests
server cancellation.

The **Explore** view includes a synchronized repository tree from repository
through solution, module, district, and file. City or search selection expands
only the selected path and scrolls it into view; selecting a district or file
in the tree focuses the same 3D entity without leaving Explore. Arrow keys,
Home, End, Enter, and Space provide complete keyboard navigation with ARIA
tree semantics. A fixed-row virtual window keeps at most 160 rows in the DOM
for large repositories, while expansion, active-row, and scroll state are
retained independently for the
eight most recently viewed projects.

When a completed import has an evolution companion, the viewer verifies its
declared size and SHA-256 digest in a dedicated worker and opens a repository
timeline. First/previous/play/next/last controls, a direct scrubber, and four
playback speeds seek deterministic commit frames without moving the camera.
Added buildings rise in green, removals fade as red ghosts, renames are cyan,
and moved or resized buildings are amber. Dependency additions, removals,
  metadata changes, and retargets identify their affected target-frame
  endpoints and visible routes in pink and report exact relationship counts in
  the timeline status and legend until the next seek. Enabled
building-route directions and limits, plus cross-district visibility, kind
filters, limits, and a still-valid selected route survive every seek; their
content and geometry are rebuilt from the target frame. Reduced-motion mode
publishes each frame directly with no spatial interpolation. The **Building age** and
**Historical churn** visualization modes, commit metadata, and selected
building history are available only while a verified timeline is loaded.

The live viewer uses one perspective, three-quarter 3D camera with orbit,
zoom, and pan navigation. **Fit city** and contextual **Focus selection**
frame deterministic model-derived bounds without letting labels, highlights,
routes, or evolution ghosts change the result.

**Export PNG** renders the scene directly at a resolution independent of the
browser viewport. It supports isometric, top-down, selected-entity, and
whole-city framing; perspective or orthographic projection; the scene or a
transparent background; and optional selected/hover labels, visualization
legend, and current evolution-frame metadata. The image contains no viewer UI
chrome. Width and height are each bounded from 256 through 8192 pixels, subject
to the active GPU's texture, renderbuffer, and viewport limits and a 512 MiB
sample-aware estimated working-memory ceiling. A lost or unavailable WebGL
context disables image export with an accessible explanation; startup failure
shows a dedicated fallback, and context restoration re-enables the controls.

Completed imports remain on the server until explicitly removed. An
authenticated `GET /api/v1/jobs` enumerates all retained jobs; for each
completed `project-import`, send
`DELETE /api/v1/imports/<job-id>/result` with
`X-Code-City-Request: 1` to remove its persisted job record, city model, and
optional evolution companion. API reads and mutations remain `no-store`.
The wizard's **Remove stored import** action manages the one completed result
whose opaque UUID is saved in that browser; use the jobs API to enumerate and
remove older retained results.

History imports are reproducible from immutable commit SHAs and emit frames in
oldest-first order. The recommended `root-to-tip` mode proves that the bounded
first-parent traversal reached the repository root, then distributes up to
`maxFrames` representative snapshots by elapsed time across the complete span.
The oldest and newest commits are always included. If the selected tip
timestamp is not later than the root timestamp, sampling falls back to
deterministic ancestry positions. For example:

```json
{
  "source": {
    "kind": "github",
    "repositoryUrl": "https://github.com/acme/example"
  },
  "history": {
    "mode": "root-to-tip",
    "maxFrames": 20,
    "totalDeadlineMs": 1800000
  }
}
```

Complete-mainline mode indexes at most 100,000 commits while loading and
analyzing source only for the selected frames. A longer mainline is rejected
with a specific instruction to choose a bounded custom range; Code City never
labels a recent suffix as a complete history. It requires the Git server to
support a verifiable treeless partial fetch and fails closed with the same
bounded-range escape hatch when that capability is unavailable. Custom recent-commit, date, and
tag selections remain limited to 500 traversed commits and retain the advanced
`sampleEvery` interval. Date selections use `fromInclusive`,
`toInclusive`, and a mandatory
`maxCommits`; tag selections use unqualified `oldestTagName`,
`newestTagName`, and a mandatory `maxCommits`. Every request is rejected before
repository analysis unless its declared bounds can produce at most 100 sampled
frames. Because Git commit timestamps need not be monotonic, a date range is
accepted only when the first-parent traversal
reaches the repository root within `maxCommits`; this prevents an older commit
with an in-range timestamp from being silently omitted. Hard ceilings also
limit exact tags to 64, commit parents to 64, accumulated sampled-boundary
changed paths to 500,000, and retained change data to 16 MiB. The overview
computes one net Git diff between each pair of adjacent sampled frames rather
than retaining every intermediate commit's path changes. Rename detection
across a sampled gap is therefore Git's deterministic best effort. Retained
change data charges the
UTF-8 bytes of current and previous path names plus a conservative 128 bytes
of record overhead for every parsed change. Retained semantic facts are capped
at 128 MiB using explicit string, object, array, property, and reference
charges. Historical frames retain the stable identities, aggregate metrics,
and relationship inputs needed for animation; the newest frame additionally
retains callable and source-structure detail for code inspection. Other ceilings
limit accumulated tree entries to 2,000,000, stable lineages to 100,000, and
the serialized evolution artifact to a browser-safe 64 MiB. Every runtime JSON
string and property name in an evolution bundle is limited to 64 KiB of
encoded UTF-8.
The total deadline is at most two hours and covers history analysis, canonical
evolution preparation and publication, and temporary import cleanup. Lower
`analysis.timeoutMs` supplies that history deadline only when
`history.totalDeadlineMs` is omitted; requests that provide both are rejected
instead of silently ignoring either value. Lower
per-request bounds are available through
`maxAggregateChangedPaths`, `maxAggregateChangedPathBytes`,
`maxAggregateSemanticBytes`, `maxAggregateTreeEntries`, `maxUniqueLineages`,
`maxEvolutionOutputBytes`, and `totalDeadlineMs`.

The 64 MiB evolution ceiling is enforced by analysis, publication, persisted
job metadata, and the viewer. The viewer rejects oversized legacy metadata
before downloading it. For accepted artifacts it allocates exactly the
declared length, copies response chunks directly into that one owned buffer,
and transfers the same buffer to the timeline worker. Main-thread binary
retention is therefore bounded to one full artifact buffer plus the current
transport chunk; it does not retain every chunk or make another full transfer
copy. Digesting, UTF-8 decoding, JSON parsing, validation, and replay state add
engine-dependent worker allocations, so self-hosted deployments should reserve
at least 512 MiB of transient browser memory for each timeline being loaded.
Reduce the maximum animation frames, choose a custom range, or lower
`maxEvolutionOutputBytes` when that budget is unavailable.

The server keeps credential-free semantic facts in a private, versioned,
bounded cache under `CODECITY_DATA_DIR`; immutable commit SHA, analyzer
fingerprint, and semantic configuration form the cache key. Interrupted jobs
can therefore reuse completed commit analyses. Source URLs, credentials,
symbolic tag names, and author identity are not stored in cache entries or
evolution artifacts. Presentation identity is excluded from cache keys and
entries, then attached to the published city frames. Evolution author policy
`omit-v1` persists no author name, email, ID, or avatar. `GET` and `HEAD`
`/api/v1/artifacts/<job-id>/evolution.json` use the same inbound authorization
policy as the city-model artifact and send `Cache-Control: no-store`.

The viewer worker reuses its last successfully validated evolution frame and
retains every tenth replayed frame as a structurally shared checkpoint.
Sequential playback therefore applies each delta once. Arbitrary seeks start
each uncached endpoint at the newest preceding checkpoint, applying at most
nine deltas per warm endpoint. A first cold endpoint can fall back to the
current frame or baseline, but the validated 100-frame artifact limit caps
that fallback at 99 delta applications. Checkpoints discovered by a seek stay
request-local until its final cancellation check, so superseded work cannot
alter later playback state.

At most four upload reservations and 256 MiB of staged upload data exist at
once. City models are capped at 128 MiB, ZIPs at 64 MiB, unused reservations
expire after five minutes, and each upload has 30-second idle and ten-minute
total deadlines. Reservation expiry, disconnect, cancellation, job failure,
shutdown, and restart remove private staging data. Upload endpoints are also
open in default trusted-network mode and protected with the rest of the API
when inbound authorization is enabled.

Inbound authorization can be enabled without changing the public viewer or
health check. Put one machine-generated 32-byte base64url token in a private
file, configure its absolute in-container path as
`CODECITY_AUTH_TOKEN_FILE`, and set one exact `CODECITY_PUBLIC_ORIGIN`, for
example `https://codecity.lan`. When enabled, every `/api/v1` route except
`GET` or `HEAD /api/v1/health` and the session bootstrap is protected. API
automation may send the token as one `Authorization: Bearer` header. A
same-origin browser exchanges it once at `POST /api/v1/auth/session` for an
opaque eight-hour `HttpOnly`, `SameSite=Strict` session cookie; the long-lived
token and repository credentials are never stored in the browser. Login,
logout, imports, uploads, and job cancellation still require the exact
`X-Code-City-Request: 1` header. Cookie-authenticated mutations additionally
require the configured same-origin `Origin`.

The token file is read once before the server opens its data directory. On
POSIX it must be a non-linked regular file owned by the service identity with
mode `0400` or `0600`. Mount Docker secrets so UID 10001 owns the file and no
group or other identity can read it. On Windows, protect the file and its
canonical ancestry with an ACL limited to the service identity and trusted
administrators, then set
`CODECITY_TRUST_WINDOWS_AUTH_TOKEN_FILE=1` as an explicit attestation. Do not
put the token itself in an environment variable, command line, URL, repository,
job data, or browser storage. Token replacement takes effect only after a
server restart and invalidates all sessions.

Credential-profile discovery and selection are available only when that
inbound authorization mode is configured. Set
`CODECITY_CREDENTIAL_PROFILES_FILE` to an absolute manifest path. The version-1
manifest names bounded, exact repository scopes and direct-child secret files:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "github-read",
      "label": "GitHub read token",
      "provider": "github",
      "repositories": ["https://github.com/acme/example"],
      "authentication": {
        "kind": "bearer",
        "secretFile": "github-read.secret"
      }
    },
    {
      "id": "azure-build",
      "label": "Azure DevOps build identity",
      "provider": "azure-devops",
      "repositories": [
        "https://dev.azure.com/acme/project/_git/example"
      ],
      "authentication": {
        "kind": "basic",
        "username": "build-user",
        "secretFile": "azure-build.secret"
      }
    }
  ]
}
```

The manifest and one-line UTF-8 secret files must share one private directory.
That credential directory and the viewer asset root must be canonically
disjoint in both directions; startup rejects overlap before viewer assets are
collected or served. The asset collector also verifies the opened directory
and file identities during traversal, rejecting bind-mount, hard-link, reparse,
or rename aliases to the credential directory, manifest, or secrets before
reading file bodies.
On POSIX the directory must be owned by the service identity with mode `0700`;
every file must be owned by it, regular, non-linked, and mode `0400` or `0600`.
Canonical paths and file identities are checked around bounded reads. Code City
records each secret's protected path and security-relevant startup snapshot:
file identity, mode and ownership, link count, size, and modification and change
times. It validates the contents and overwrites the validation buffer. On
Windows, apply equivalent private ACL and protected-ancestry controls and set
`CODECITY_TRUST_WINDOWS_CREDENTIAL_FILES=1` to attest them. IDs, labels, and
providers are the only fields returned by authenticated
`GET` or `HEAD /api/v1/imports/capabilities`; repository scopes, usernames,
secret filenames, and secret contents are never returned.

GitHub scopes use canonical `https://github.com/owner/repository` URLs and
case-insensitive repository identity. Azure DevOps accepts its exact cloud,
legacy `visualstudio.com`, and on-premises HTTPS `_git` paths. Generic HTTPS
scopes normalize only the authority and otherwise match the authorized raw
path exactly, including case, percent encoding, and a terminal `.git`.
GitHub profiles are bearer-only; their secret file contains one ASCII RFC 6750
`b64token` line. Azure DevOps and Generic HTTPS profiles are Basic-only; their
visible-ASCII username cannot contain a colon, and they require a one-line UTF-8
secret.

An authenticated GitHub or canonical HTTPS `kind: "git"` import may add the
optional, strictly validated `source.credentialProfileId` field. GitHub sources
require a `github` profile; HTTPS Git sources require an `azure-devops` or
`generic-https` profile. Before staging or queue persistence, the server
requires the selected provider and exact repository scope to match the request.
Each job reopens the secret through its protected startup path and revalidates
that path and security-relevant startup snapshot, including file identity, mode
and ownership, link count, size, and modification and change times. The
credential is exposed only to one callback; all callback-scoped mutable
credential buffers are overwritten after success, failure, abort, or registry
close.

The bearer credential is sent only as an `Authorization` header on exact HTTPS
requests to `api.github.com`. A token used for private or internal archive
access needs repository `Contents: read` permission. Redirect following remains
disabled. The documented zipball API response must be one `302` whose path is
exactly `/{owner}/{repo}/legacy.zip/{sha}` on `codeload.github.com`; an opaque
query string is accepted, and the second fetch sends no `Authorization` header.
This permits exact-scope private and internal GitHub imports without exposing
the token to the archive host.

For selected Azure DevOps or Generic HTTPS imports, Code City disables inherited
system, global, and user Git configuration for the bounded Git commands and
uses the chosen Basic profile as its only repository credential helper through
an ephemeral owner-restricted broker. Redirects remain disabled. The username
and secret never enter the remote URL, process arguments, environment, Git
configuration, job, artifact, or temporary file. Each broker and helper
exchange is bounded and tied to the Git command. Broker cleanup is awaited
before the profile callback returns; failure to confirm closure fails the
import after a bounded force-termination attempt. Azure DevOps profiles are
intended for least-privileged PATs with Code Read access; Entra or OAuth bearer
flows are not supported by this profile type. Installed Git, the resolved .NET
runtime, and configured proxy and certificate environment settings remain
trusted local dependencies.

The selector, secret, remote URL, and requested symbolic ref are never written
to a job or artifact. The resolved immutable commit SHA may be stored as the
generated model's default version. Source retention is disabled unless an
operator explicitly sets `CODECITY_SOURCE_RETENTION=retain`. When enabled,
bounded analyzed source files are
published separately under the service-private
`CODECITY_DATA_DIR/sources/<job-id>` tree. They are never embedded in the city
model, evolution bundle, printable output, or public legend. Every source read
uses the normal inbound API authorization and reads only a bounded authenticated
index plus the selected digest-verified file. Omitted, empty, or explicitly
`disabled` retention keeps only immutable provenance; the viewer then shows an
explicit reduced-capability state. Enabling retention stores private source
bytes on the server and therefore requires the data directory's private
filesystem and backup policy to be appropriate for that repository.

The read-only inspector opens the selected building's exact retained file and
lets executable-unit rows jump to their recorded line range. GitHub and Azure
DevOps links are commit-pinned. An optional local adapter is disabled unless
`CODECITY_EDITOR_URL_TEMPLATE` is configured with `{path}` and optional
`{line}` placeholders, for example
`vscode://file/C:/work/example/{path}:{line}`. Only `https`, `vscode`, and
`vscode-insiders` templates without embedded credentials are accepted.

Anonymous GitHub snapshot
imports remain archive-based; history imports use the installed Git backend so
its pinned rename behavior and version can be recorded in provenance. The
Compose file forwards the source-retention and editor-adapter settings. It also
forwards credential-manifest configuration but deliberately does not mount a
host manifest or secret; operators must provide a private mount explicitly.
Never place profile secrets in Compose environment values, Git configuration,
a remote URL, or the repository.

Authorization protects credential use but does not encrypt the bearer or
session capability in transit. `CODECITY_PUBLIC_ORIGIN` therefore requires
HTTPS; plain HTTP is accepted only when the server itself is bound to
loopback. Azure Web App and IIS can terminate TLS at their normal ingress. A
Raspberry Pi credential-enabled deployment needs TLS termination (for example
at a private Caddy ingress); the original no-auth trusted-LAN mode does not.
Keep the Node backend reachable only from that ingress, preserve the external
`Host`, and never trust client-supplied forwarded identity headers. Configure
proxy and platform access logs to omit `Authorization`, `Cookie`, and
`Set-Cookie`.

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

The origin list is egress control, not per-repository authorization, and a
selected profile never replaces this gate. In default trusted-network mode,
every Code City network client can request any repository/user at an enabled
origin. Unselected HTTPS and SSH/scp imports may invoke the service account's
ambient credential helper, SSH agent/configuration, and enterprise CAs;
selected HTTPS imports isolate ambient Git configuration and repository
credential helpers and use the exact chosen profile for repository
authentication. Configured proxy and certificate environment settings remain
in effect. Enable Generic Git only on a network where every client is
authorized, or enable inbound authorization, and use a least-privileged
service identity.
On Windows/IIS, enabled origins also require
`CODECITY_TRUST_WINDOWS_GIT_WORKSPACE=1`. That flag attests that the data/import
workspace ACL and inherited child ACLs are limited to the service identity and
trusted administrators and that canonical ancestors prevent untrusted rename,
delete, and delete-child access; Code City cannot verify or establish those ACL
properties. Every history import, including anonymous GitHub history, uses the
installed Git backend and therefore requires the same Windows trust assertion.
An anonymous GitHub snapshot without `history` remains archive-based and does
not require it.

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
reference. Local analysis may also embed a normalized, one-bit printable relief
derived from a single bounded logo file beneath an explicitly analyzed root.
Both 3MF and STL consume that same relief geometry; unsupported or unsafe logos
fall back to the fixed Code City icon with one sanitized preflight warning.

Metric mappings are versioned data inside that shared model. Footprint, height,
and color can independently use SLOC, decision load, maximum complexity, or
executable-unit count. Each channel records its formula, normalization, cap,
missing-value policy, geometry range or color scale, and provenance. The
available Complexity, Maintenance, and Print presets are complete mapping
definitions. Dependencies, Ownership, and Evolution remain visible but
unavailable until their required per-building facts exist.

The viewer previews mapping changes in a cancellable worker before applying
them. Geometry changes atomically rebuild layout, routes, bounds, picking data,
and print state; print export always consumes the mapping applied on screen.
Named custom configurations stay in browser storage scoped to the loaded
project. The exact original fixed mapping remains compatible, and one resolved
mapping is applied consistently across all frames of a history analysis.

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

The viewer starts in **Explore**, where overview, color mode, search, and the
synchronized repository tree share one task-oriented workspace. Selecting a
building opens contextual **Details** with complexity hotspots first; use
**Back to workspace** to return without losing Explore or Analyze state.
**Analyze** opens on explainable design-smell findings and groups Routes and
Queries as secondary analysis tools. Metric Mapping and Safe Extensions live
under **Project > Advanced settings**. History color modes appear only while
verified history is loaded, and print assignment appears only after a valid
printer profile is available.

Contextual **Details** includes one **Code inspection** area. Its **Code
outline** is analyzer-recorded types and callables inside the selected file,
not a filesystem tree. Selecting a building or expanding the outline performs
no source request; **Open retained source**, hotspot/unit links, declarations,
and findings are explicit source actions. Complexity focus explains persisted
cyclomatic-complexity decision sites as `1 base path + decision contribution`
and highlights their exact inclusive UTF-16 token ranges without re-analyzing
source in the browser. AI controls appear only when a provider is configured,
and **Prepare AI preview** is always an explicit action separate from the
one-time send confirmation.

The viewer accepts a `city-model.json` through **Project > Open model**.
**Export > Export print file** selects a generic, Prusa XL, or local custom
printer profile, previews the exact exporter layout, and downloads direct
3MF/STL or a deterministic multi-plate ZIP.
Generation runs locally in a cancellable worker; no model or profile is uploaded.
The default **Auto fit (recommended)** treats scale 3 as a target: it tries the
target on one plate, a profile-safe one-plate fit, then complete-district
tiling. If real detail limits leave only a smaller complete one-plate fit, the
viewer shows that exact proposal and requires **Confirm compact fit** before it
serializes or offers a download. There is no ordinary Expert checkbox.
For Prusa XL 3MF exports with at least two enabled tools, **Wipe tower strip**
reserves an empty rear strip outside the continuous city base. Its 72 mm
default covers the [official profile's 60 mm nominal tower width](https://github.com/prusa3d/PrusaSlicer/blob/master/resources/profiles/PrusaResearch.ini),
standard brim, and placement clearance. PrusaSlicer centers imported geometry,
so move the complete city flush to the front edge, do not run Arrange afterward,
and place the tower in the revealed rear strip. Verify the sliced G-code
preview; use 0 when the tower is disabled or increase the reservation when the
preview is wider.
**Prepare calibration** downloads a profile-only test plate and measurement
manifest.

**Analyze > Queries** provides explainable built-in rankings,
dependency neighborhoods, change filters, and compound name, language, risk,
metric, dependency, and design-smell filters. Results support additive and
range selection from query, tree, scene, and visible search order. Focus uses
the combined selection bounds; isolate applies an exact cross-district
building mask; compare exposes a summary plus at most 100 accessible
per-building metric rows; and the dependency overlay deduplicates and caps
routes gathered from every selected endpoint. Overlay and JSON export remain
available for the same selection.
Project-scoped saved queries and selection sets retain their versioned model,
metric, and rule capabilities. Evaluation runs in a disposable worker and
returns at most 500 of the deterministically ranked matches while reporting
the full total and any unavailable capability.

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
CLI exports use profile-safe `--fit scale` or complete-district `--fit tile`;
the viewer's Auto workflow tries both where they are viable.
Experts may add `--acknowledge-below-profile-scale` to permit an explicitly
requested lower scale or let `--fit scale` search below the profile-safe floor.
The default remains a hard rejection. Preflight and deterministic manifests
record requested, applied, and profile-safe scales plus every below-limit
feature's resulting millimetres and configured minimum. This acknowledgement
accepts possible lost, merged, or fragile detail; it never bypasses the
printer's physical build volume. Shared plate bases and exposed district
foundations are regenerated after scaling as physical supports: shared bases
are clamped to the profile's minimum base thickness, while district foundations
are clamped to the larger of the minimum base thickness and minimum raised
feature height. Those supports are excluded from the scalable-detail safety
floor. When a district foundation is thickened, its buildings are lifted by
the same delta so they remain seated on it. Every completed viewer export
refuses non-empty unplaced objects. In the browser, a completed one-plate plan
downloads direct STL/3MF; only a completed multi-plate plan is wrapped in a
ZIP. Direct STL/3MF exports write a
`.print-manifest.json` sidecar, while bundle metadata stays in `manifest.json`;
arbitrary fonts and slicer settings remain separate. Printable custom logos are
local-only, must be transparent single-color SVG or PNG silhouettes, and are
simplified to the selected printer profile's minimum feature size.

## Local product flow

`codecity open` accepts one or more local roots and serves only on
`127.0.0.1`; it prints the URL without launching a browser.

Architecture documentation uses Antora and the concise arc42 structure. It is
published at
<https://felixgeisler.github.io/code-city/>.

## Development

The supported local toolchain is **Node.js 24.x**, **npm 11.6.2**, and the
**.NET SDK 10.0.302** used to build the trusted Roslyn and Git credential
helpers. The repository pins these versions; use the committed
`package-lock.json` through `npm ci`.

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
# Optional application-owned authorization:
$env:CODECITY_AUTH_TOKEN_FILE = "C:\CodeCitySecrets\authorization-token"
$env:CODECITY_PUBLIC_ORIGIN = "https://codecity.lan"
$env:CODECITY_CREDENTIAL_PROFILES_FILE = "C:\CodeCitySecrets\credential-profiles.json"
# Windows only, after provisioning and auditing the data-directory ACL:
$env:CODECITY_TRUST_WINDOWS_GIT_WORKSPACE = "1"
# Windows only, after provisioning and auditing the token-file ACL:
$env:CODECITY_TRUST_WINDOWS_AUTH_TOKEN_FILE = "1"
# Windows only, after provisioning and auditing the credential-directory ACL:
$env:CODECITY_TRUST_WINDOWS_CREDENTIAL_FILES = "1"
npm run server:start
```

`verify` runs the same sequence used by Linux and Windows CI: typecheck, tests,
the production build, and the Antora documentation build. CI bounds each
verification job to 20 minutes.

## Status

First executable vertical slice. The open-source license will be chosen before
the first public release.
