# Code City 1.0.0

Code City 1.0.0 is the first stable release of the self-hosted repository
visualization and physical-model workflow.

## Highlights

- Import a Git repository, source folder/ZIP, or generated Code City model.
- Explore a bounded interactive 3D city and representative repository history.
- Export images, STL, deterministic 3MF, and multi-plate five-tool print files.
- Publish sanitized immutable city snapshots with latest and permanent links.
- Run the complete viewer and API from one non-root AMD64/ARM64 container.

## Compatibility

- Container platforms: `linux/amd64` and `linux/arm64`.
- Source development toolchain: Node.js 24, npm 11, and .NET SDK 10.0.302.
- Viewer baseline: a current WebGL 2 browser.
- Persistent data is stored under `CODECITY_DATA_DIR` (`/data` in the release
  container). Back up that directory before upgrading.

## Security

Authorization is disabled by default for trusted private-network deployments.
Do not expose that mode directly to the public Internet. Configure inbound
authorization, allowed hosts, a public origin, and exact credential profiles as
documented when deploying beyond a private network.

Published snapshots are intentionally readable without browser credentials by
anyone who can reach the deployment. Publication strips source provenance,
repository URLs, diagnostics, credentials, and AI context.

## Installation and upgrade

Follow `docs/modules/ROOT/pages/14-release-and-operations.adoc` for image tags,
preflight checks, cold backup, restore, upgrade, rollback, and smoke validation.
See `CHANGELOG.md`, `SECURITY.md`, `LICENSE`, `NOTICE`, and
`THIRD_PARTY_NOTICES.md` before deployment.
