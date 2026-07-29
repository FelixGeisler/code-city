# Code City

<img src="apps/viewer/src/code-city-icon.svg" width="64" height="64" alt="Code City icon">

Code City turns a software repository into:

- an interactive 3D city that can be explored in a web browser; and
- a printable multi-part 3MF or single-material STL model.

The CLI supports public GitHub repositories, generic Git remotes such as Azure
DevOps Server, and local checkouts that can be analyzed fully offline.

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

# Analyze one advertised branch, tag, or exact commit through installed Git
npm run cli -- analyze-git https://dev.azure.example/Collection/Project/_git/Repo `
  --ref main `
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

The viewer accepts a `city-model.json` through **Open model**. **Export print file**
selects a generic, Prusa XL, or local custom printer profile, shows exact
preflight dimensions and channel assignments, then downloads 3MF or STL and an
optional private legend. Generation runs locally in a cancellable worker; no
model or profile is uploaded. **Prepare calibration** downloads a profile-only
test plate in the selected format and an exact measurement manifest.

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
For Azure Pipelines, prefer `checkout: self` with `persistCredentials: false`
and analyze `$(Build.SourcesDirectory)` locally.

The Demo imports into PrusaSlicer as one object with five aligned tool parts;
the command reports its profile-derived size. `--routes auto` prints capped,
aggregated district dependencies; routes default to `off`. The private JSON
legend maps printed codes to repository-relative paths; use `--labels off` or
`--legend off` as needed. Oversized exports fail with measured bounds; automatic
fitting and tiling, arbitrary fonts or logos, and slicer settings remain
planned.

## Planned product flow

`codecity open` accepts one or more local roots and serves only on
`127.0.0.1`; it prints the URL without launching a browser. Oversized
multi-plate exports remain planned.

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

`verify` runs the same sequence used by Linux and Windows CI: typecheck, tests,
the production build, and the Antora documentation build. CI bounds each
verification job to 20 minutes.

## Status

First executable vertical slice. The open-source license will be chosen before
the first public release.
