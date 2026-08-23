# Code City

Code City turns a public GitHub repository into a deterministic city. Open the [hosted application](https://felixgeisler.github.io/code-city/), enter a public repository URL such as `https://github.com/FelixGeisler/code-city`, and select **Build city**. The protected default branch is `main`.

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

## Production evidence and finalization

Pull requests run only the `verify` check. A protected-`main` push runs the separate publication workflow, builds once, deploys that exact Pages artifact, and—while [acceptance issue #460](https://github.com/FelixGeisler/code-city/issues/460) is open—collects a sealed seven-file production-evidence artifact. Collection runs without a GitHub token in the collector environment. The workflow summary records the authenticated artifact and packet bindings needed for local finalization.

After independently authenticating and downloading that artifact into a marker-free `sealed/` directory, save the workflow/API bindings as sibling `artifact-metadata.json` and run:

```bash
node tools/finalize-production-evidence.mjs --packet <production-dir>/sealed --metadata <production-dir>/artifact-metadata.json --output <production-dir>/wrapper.json
```

The finalizer is offline. It validates the downloaded packet and metadata, then publishes canonical `wrapper.json` without replacing an existing file. Production evidence and the wrapper remain release-review inputs; deployment alone is not acceptance.

## Documentation

Product requirements and architecture are maintained as an Antora site under `docs/`. Build it independently with:

```bash
npm run docs:build
```
