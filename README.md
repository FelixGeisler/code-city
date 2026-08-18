# Code City v2

Code City is being reimplemented from accepted requirements and architecture.
The protected default branch is `main`. The former 1.x line is retained only as
the locked archival branch `v1`; it is not a development, release, or Pages
publication source.

## Develop

Use Node 24, npm 11, and the pinned dependency closure.

```bash
npm ci --ignore-scripts
npm run dev
```

The development shell is available at
<http://localhost:5173/code-city/>. Stop the server with Ctrl+C.

## Build and serve the package

```bash
npm run build
npm run start
```

The clean production package is written to `dist/`; its external integrity
manifest is written to `build/evidence/package-manifest.json`. The packaged
shell is served at <http://127.0.0.1:4173/code-city/>. Stop the server with
Ctrl+C.

Run the complete local gate with:

```bash
npm run verify
```

That gate type-checks the main and worker contexts, runs conformance tests,
builds once, compares a separate reproducibility build, audits the unchanged
canonical package over local HTTP, and builds the documentation.

## Documentation

Requirements and architecture are maintained as an Antora site under `docs/`.
Build them independently with:

```bash
npm run docs:build
```

Final production publication remains a separate reviewed action owned by
[issue #460](https://github.com/FelixGeisler/code-city/issues/460); building or
verifying the shell does not deploy it.
