# Code City

<img src="apps/viewer/src/code-city-icon.svg" width="64" height="64" alt="Code City icon">

Code City turns a software repository into:

- an interactive 3D city that can be explored in a web browser; and
- a printable multi-part 3MF model for a 3D printer.

The project will support public GitHub repositories, generic Git remotes such as
Azure DevOps Server, and local checkouts that can be analyzed fully offline.

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

# Run the browser viewer
npm run viewer:dev

# Build and open a local repository through the bundled production viewer
npm run viewer:build
npm run cli -- open C:\Code\RepoA

# Export the connected five-part Demo for a Prusa XL
npm run print:demo

# Export another model through the same printer-general path
npm run cli -- export `
  --model examples\demo-city.json `
  --profile profiles\prusa-xl-5t.json `
  --format 3mf `
  --scale 3 `
  --labels auto `
  --routes auto `
  --legend build\print\code-city-demo.legend.json `
  --output build\print\code-city-demo.3mf
```

The viewer accepts a `city-model.json` through **Open model**. **Export 3MF**
selects a generic, Prusa XL, or local custom printer profile, shows exact
preflight dimensions and channel assignments, then downloads the 3MF and
optional private legend. Generation runs locally in a cancellable worker; no
model or profile is uploaded.

C# is analyzed by the bundled, syntax-only Roslyn helper. TypeScript and
JavaScript use the pinned compiler API. Neither analyzer restores, builds, runs
plugins, or executes repository content.

The Demo imports into PrusaSlicer as one object with five aligned tool parts;
the command reports its profile-derived size. `--routes auto` prints capped,
aggregated district dependencies; routes default to `off`. The private JSON
legend maps printed codes to repository-relative paths; use `--labels off` or
`--legend off` as needed. Oversized exports fail with measured bounds; automatic
fitting and tiling, STL, arbitrary fonts or logos, and slicer settings remain
planned.

## Planned product flow

`codecity open` accepts one or more local roots and serves only on
`127.0.0.1`; it prints the URL without launching a browser. Public GitHub and
generic Git remotes such as Azure DevOps Server remain planned, as do STL and
oversized multi-plate exports.

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
