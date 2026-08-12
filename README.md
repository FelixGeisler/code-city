# Code City

<img src="apps/viewer/src/code-city-icon.svg" width="64" height="64" alt="Code City icon">

**Turn a software repository into an interactive 3D city, explore how it
changes, and export it as an image or physical model.**

<p>
  <img src="docs/modules/ROOT/images/code-city-overview.webp" width="49%" alt="Code City 3D repository overview with hierarchy explorer">
  <img src="docs/modules/ROOT/images/code-city-analysis.webp" width="49%" alt="Code City analysis view with explainable findings">
</p>

## What it can do

- Import a **Git repository**, **source folder or ZIP**, or generated Code City
  model. GitHub, Azure DevOps, and operator-approved HTTPS or SSH Git are supported.
- Explore solutions, modules, districts, buildings, dependencies, source
  hierarchy, metrics, findings, saved queries, and changes over time.
- Export documentation images, STL, deterministic 3MF, multi-plate layouts,
  physical labels, dependency routes, and Prusa XL five-tool models.
- Publish sanitized immutable city snapshots with latest and permanent public
  links, version history, republishing, and revocation.
- Keep analysis self-hosted. Repository code is inspected, never built or
  executed. Credentials use explicit administrator profiles or a configured
  Git service identity; they are never accepted in repository URLs.
- Run on AMD64 or ARM64 from one non-root container with one persistent volume.

## Start Code City

One command starts the complete viewer and API with persistent storage:

```bash
docker run --detach --name code-city --restart unless-stopped --publish 8080:3000 --volume code-city-data:/data ghcr.io/felixgeisler/code-city:1.0.0
```

Open **http://localhost:8080** in a current Chromium-based browser with WebGL 2.
Other browsers may work but are not part of the automated 1.0 baseline.

Authorization is disabled by default for convenient trusted-network use. Do
not expose that mode directly to the public Internet. Configure authorization,
allowed hosts, a public origin, and exact credential profiles before an
Internet-facing deployment. Published snapshots are intentionally readable by
anyone who can reach the server.

To build the container from this source checkout instead:

```bash
docker compose up --build
```

## Development

Requirements: **Node.js 24.x**, **npm 11.6.2**, **.NET SDK 10.0.302**, and Git.

```bash
npm ci
npm run verify
npm run viewer:dev
```

`npm run viewer:dev` starts both the real viewer and API with same-origin
`/api` calls at **http://127.0.0.1:5173/**. Development data is private and
local; see the deployment documentation before using production credentials.

## Documentation and release information

- [Concise architecture overview](docs/modules/ROOT/pages/index.adoc)
- [Release, backup, restore, upgrade, and rollback procedure](docs/modules/ROOT/pages/14-release-and-operations.adoc)
- [1.0.0 release notes](RELEASE_NOTES.md)
- [Security policy](SECURITY.md)

The visualization concept is described by Richard Wettel and Michele Lanza in
[*CodeCity* (2008)](https://doi.org/10.1145/1370175.1370188).

Code City is licensed under the [Apache License 2.0](LICENSE). Project identity
and trademark information is in [NOTICE](NOTICE).
