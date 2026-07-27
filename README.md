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
| Dependencies | Roads |
| Churn or maintenance risk | Color or material |

The browser and print outputs are generated from the same versioned
`city-model.json`, so the physical model corresponds to the city visible on
screen.

## Planned usage

```powershell
# Local or offline repository
codecity open .

# Public GitHub repository
codecity open https://github.com/owner/repository

# Generic Git or Azure DevOps Server repository
codecity open https://devops.example/collection/project/_git/repository

# Printable export
codecity export . --format 3mf --profile prusa-xl-5t
```

## Initial scope

The first vertical slice will analyze a local TypeScript/JavaScript repository,
produce a deterministic city model, display it in an interactive Three.js
viewer, and export a printer-safe model. Public GitHub ingestion and additional
language analyzers follow on the same core pipeline.

Architecture documentation uses Antora and the concise arc42 structure. Once
GitHub Pages is enabled, it is published at
<https://felixgeisler.github.io/code-city/>.

Build it locally with:

```powershell
npm ci
npm run docs:build
```

## Status

Planning and project setup. The open-source license will be chosen before the
first public release.
