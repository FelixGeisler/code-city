# Code City

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

# Produce a capability-checked print plan
npm run cli -- plan `
  --model build\city-model.json `
  --profile profiles\prusa-xl-5t.json `
  --format 3mf `
  --output build\print-plan.json
```

The viewer also accepts a `city-model.json` through its **Open model** button.
The first C# implementation is explicitly labelled lexical; Roslyn replaces it
without changing the model contract.

## Planned product flow

`codecity open` will accept local roots, public GitHub repositories, and generic
Git remotes such as Azure DevOps Server. STL and 3MF mesh exporters follow the
implemented print planner.

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
