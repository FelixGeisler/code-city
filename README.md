# Code City

<img src="apps/viewer/src/code-city-icon.svg" width="64" height="64" alt="Code City icon">

Code City turns a software repository into:

- an interactive 3D city that can be explored in a web browser; and
- a printable STL or multi-part 3MF model for a 3D printer.

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

# Export the connected five-part Demo for a Prusa XL
npm run print:demo

# Export another model through the same printer-general path
npm run cli -- export `
  --model examples\demo-city.json `
  --profile profiles\prusa-xl-5t.json `
  --format 3mf `
  --scale 3 `
  --labels auto `
  --legend build\print\code-city-demo.legend.json `
  --output build\print\code-city-demo.3mf
```

The viewer also accepts a `city-model.json` through its **Open model** button.
The first C# implementation is explicitly labelled lexical; Roslyn replaces it
without changing the model contract.

The labelled Demo is 93 x 48 x 33.8 mm and imports into PrusaSlicer as one
object with five aligned tool parts. Its private JSON legend maps printed codes
to repository-relative paths; use `--labels off` or `--legend off` as needed.
STL, FLOW-sized tiling, arbitrary fonts or logos, and slicer settings remain
planned.

## Planned product flow

`codecity open` will accept local roots, public GitHub repositories, and generic
Git remotes such as Azure DevOps Server. STL and oversized multi-plate exports
remain planned.

Architecture documentation uses Antora and the concise arc42 structure. Once
GitHub Pages is enabled, it is published at
<https://felixgeisler.github.io/code-city/>.

Build it locally with:

```powershell
npm ci
npm test
npm run build
npm run docs:build
```

## Status

First executable vertical slice. The open-source license will be chosen before
the first public release.
