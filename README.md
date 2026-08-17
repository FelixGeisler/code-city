# Code City v2

Code City v2 is a deliberate M1 reimplementation developed from accepted
requirements and architecture before product implementation begins.

The active M1 line is named `v2` before the accepted
[ADR 0009](docs/modules/architecture/pages/adr/0009-m1-main-line-and-github-pages-cutover.adoc)
cutover and `main` after the post-merge branch administration. The previous v1
line is still named `main` before that cutover and is retained afterward as the
locked archival branch `v1`; the immutable `v1.0.0` tag remains v1 comparison
evidence. The archival line is not an active development or release base.

Only the resulting M1 `main` may publish GitHub Pages. The final M1 deployment
owned by [issue #460](https://github.com/FelixGeisler/code-city/issues/460)
replaces, rather than co-hosts, the legacy Pages documentation.

## Documentation

Requirements, architecture, and comparison material on the active M1 line are
the sole current Code City documentation and are maintained as an Antora site
under `docs/`. Documentation retained with v1 is historical and may be
outdated.

```bash
npm ci
npm run docs:build
```
