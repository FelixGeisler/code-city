# Code City

Code City builds a deterministic city from JavaScript, TypeScript, and C# in a selected local working tree or public GitHub repository. Acquisition and analysis run in a browser Web Worker; the Node.js service serves assets and explicitly saved snapshots, not analysis sessions.

## Install

Use Node 24, npm 11, and the pinned dependency closure.

```bash
npm ci --ignore-scripts
```

## Build and run

```bash
npm run build
npm start -- --port 55583 --data-dir /var/lib/code-city
```

Choose a writable data directory outside the checkout and `dist/`; on Windows,
use an absolute path under your application-data directory. Without `--data-dir`,
analysis works but Save is unavailable.

The canonical artifact is `dist/`. Only `--port` is required; `--host` defaults to `127.0.0.1`. Port `0` chooses an ephemeral port for testing. A non-loopback host also requires `--canonical-host`. Analysis/session/source-memory capacity flags are no longer accepted.

For a one-shot development build outside canonical `dist/`, without HMR or WebSockets:

```bash
npm run dev -- --port 55583
```

Development output is `build/development/`. Browser analysis requires HTTPS or a secure localhost context for Web Crypto. Plain remote HTTP is not sufficient; this package does not supply a TLS ingress. Internet deployment, direct authenticated ADO acquisition, and Raspberry Pi capacity/performance are not qualified. Local folder access uses the read-only directory picker in secure desktop Chromium; unsupported browsers show an explicit message without a server/native-helper fallback.

## Current behavior

- Select a local folder, then Analyze working-tree files including uncommitted edits; excluded metadata/dependency/build trees are pruned before descent. No Git operations or `.gitignore` interpretation occurs.
- Or analyze one anonymously accessible public GitHub repository at an immutable revision.
- Acquire files with bounded overlap, then compute metrics and construct the city in a dedicated browser worker.
- Show one continuous measured progress bar, cancellation, per-file failures, and the searchable/sortable file inventory.
- Keep unsaved sources/results in browser memory. Replacement, page exit, and worker loss release local ownership.
- Idle tabs hold no server analysis session or source reservation; completed tabs do not compete for a server analysis worker.

- Browse nested directory platforms and drill from root/parent directories to ranked files and units without camera movement.
- Inspect read-only unit source with offline Shiki syntax colors, exact complexity and owned branching contributions; no reanalysis.
- Save an immutable investigation, copy its URL, and reopen after a host restart without GitHub acquisition or parsing.
- Open saved investigations grouped by input kind and repository/folder, with separate GitHub revisions or local content-identified captures.

Version-3 snapshots store one normalized source copy plus results for every retained text file. Older pre-production payloads are not migrated or deleted and do not reopen; their receipt inventory does not block new Save operations.

There is no login, automatic saving, saved-entry management UI, or server metric certification. Snapshots include source and analysis evidence, are shared with anyone reaching the host, and never expire automatically. Back up/delete them as described in [Saved Investigations](docs/modules/requirements/pages/saved-investigations.adoc).

## Verification

```bash
npm run verify
```

The gate type-checks, tests, builds the canonical artifact once, reproduces its manifest-recorded bytes, audits public/private routing and parser integrity, drives the actual packaged browser worker with synthetic GitHub/local capabilities, qualifies external native folder access in isolated Chrome, verifies signal shutdown, and builds documentation. The browser evidence includes multiple independent tabs and the inclusive 4,000-file / 40 MiB normalized-source envelope; it is not a latency or memory guarantee.

Native folder qualification runs first, before the expensive build/browser gate,
so an unsupported OS/browser fails early rather than silently skipping access.
It runs once, not again during the package audit.

Pull requests run the gate after locked installation, dependency listing, and a high-severity audit. A protected push to `main` publishes the audited artifact and manifest-bound publication record. GitHub Pages deployment remains removed; `publication/retirement-live-verification-v1.json` preserves the earlier notice and former-asset checks.

## Documentation

Requirements and arc42 architecture are under `docs/`:

```bash
npm run docs:build
```
