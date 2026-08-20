# Code City

Code City turns an accepted public GitHub repository URL into a deterministic city from explicit product requirements and architecture. The protected default branch is `main`.

## Develop

Use Node 24, npm 11, and the pinned dependency closure.

```bash
npm ci --ignore-scripts
npm run dev
```

The development application is available at <http://localhost:5173/code-city/>. Stop the server with Ctrl+C.

## Build and serve the package

```bash
npm run build
npm run start
```

The clean production package is written to `dist/`; its external integrity manifest is written to `build/evidence/package-manifest.json`. The packaged application is served at <http://127.0.0.1:4173/code-city/>. Stop the server with Ctrl+C.

Run the complete local gate with:

```bash
npm run verify
```

That gate type-checks the main and worker contexts, runs tests, builds once, compares a separate reproducibility build, audits the unchanged canonical package over local HTTP, and builds the documentation.

## Documentation

Product requirements, architecture, and comparison evidence are maintained as an Antora site under `docs/`. Build it independently with:

```bash
npm run docs:build
```

Production publication is a separate reviewed action owned by [issue #460](https://github.com/FelixGeisler/code-city/issues/460); building or verifying the application does not deploy it.
