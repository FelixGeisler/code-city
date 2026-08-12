# Code City 1.0.0

Code City 1.0.0 is the first stable release. It turns a software repository into
an interactive 3D city. You can inspect the city in a browser, follow selected
points in the repository's history, export images, or prepare a physical model
for 3D printing.

## What you can do

### Explore a software system

- Import C#, TypeScript, and JavaScript repositories.
- Browse solutions, modules, folders, files, and source hierarchy.
- Inspect dependencies, metrics, and complexity findings.
- See how the city changed over the repository's history.

### Import from several sources

- Upload a local folder or repository ZIP.
- Import a public GitHub or Azure DevOps repository.
- Load an existing Code City model.
- Operators can configure additional approved HTTPS and SSH Git sources.

### Export and share a city

- Export images for presentations and documentation.
- Export STL or 3MF files for 3D printing.
- Prepare labeled, multi-plate models for a five-tool Prusa XL.
- Publish a sanitized, read-only city using latest and permanent links.
- Revoke a publication when it should no longer be available.

## Deployment

The supported release artifact is one Linux container containing both the
viewer and API. Images are available for AMD64 and ARM64. Code City stores jobs,
generated artifacts, and publications under `/data`; use a persistent volume and
include it in backup procedures.

See the
[release and operations guide](docs/modules/ROOT/pages/14-release-and-operations.adoc)
for startup, secure deployment, backup, restore, upgrade, rollback, and
acceptance checks.

## Security notes

Code City analyzes repository source but does not build or execute it. Imported
data and repository locations are validated and bounded before processing.
Credentials are configured separately and are not accepted in repository URLs.

Authorization is disabled by default for convenient use on a trusted private
network. Do not expose that configuration directly to the public Internet.
Configure authorization, allowed hosts, a public origin, and explicit credential
profiles first.

A published city is intentionally readable without browser credentials by
anyone who can reach the deployment. Publication removes source code,
credentials, repository URLs, diagnostics, and AI context.

## Compatibility and limitations

- Release container: `linux/amd64` and `linux/arm64`.
- Syntax-aware languages: C#, TypeScript, and JavaScript.
- Automated browser baseline: current Chromium with WebGL 2.
- Source development: Node.js 24, npm 11, and .NET SDK 10.0.302.
- For large histories, Code City shows selected points instead of every commit.
- Other browsers may work but are not part of the automated 1.0 baseline.

## Further information

- [Security policy](SECURITY.md)
- [Apache License 2.0](LICENSE)
- [Project notice](NOTICE)
