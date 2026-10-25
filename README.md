# Code City

Code City builds a deterministic city from supported JavaScript, TypeScript, and C# modules in a public GitHub repository. The standalone Node.js service owns source acquisition and analysis; its browser uses only same-origin session and command routes.

Supported languages: JavaScript, TypeScript, and C#.

## Install

Use Node 24, npm 11, and the pinned dependency closure.

```bash
npm ci --ignore-scripts
```

## Build and run

Build the canonical standalone artifact in `dist/`:

```bash
npm run build
```

Start that exact artifact by supplying `--port` and all five capacity flags:

```bash
npm start -- \
  --port 0 \
  --max-live-sessions 2 \
  --max-active-attempts 1 \
  --max-command-body-readers 2 \
  --max-command-body-bytes 4096 \
  --max-retained-source-bytes 41943040
```

Only `--host` defaults, to `127.0.0.1`. Every value above is an example for local verification, not a deployment recommendation or capacity default. A non-loopback `--host` also requires `--canonical-host`.

For one-shot development, build under `build/development/` and start the same service without HMR or WebSocket support:

```bash
npm run dev -- \
  --port 0 \
  --max-live-sessions 2 \
  --max-active-attempts 1 \
  --max-command-body-readers 2 \
  --max-command-body-bytes 4096 \
  --max-retained-source-bytes 41943040
```

The service is loopback-first. Deliberate trusted-LAN use is limited to public GitHub source. Internet exposure, private repositories, authentication, Save/recovery, and Raspberry Pi qualification are not provided.

## Verification

```bash
npm run verify
```

This gate type-checks, tests, builds the canonical artifact once, reproduces every manifest-recorded byte, audits the actual packaged server/worker/parser/browser, verifies signal shutdown and the script-free retirement notice, and builds the documentation.

Pull requests run the same gate after locked install, dependency closure, security audit, and the isolated Node type check. A protected push to `main` uploads the exact audited `dist/` artifact and separately deploys the exact audited retirement notice to Pages. The former analyzer URL inventory for the subsequent live-404 check is versioned at `publication/former-analyzer-assets-v1.json`.

## Documentation

Product requirements and architecture are maintained as an Antora site under `docs/`:

```bash
npm run docs:build
```
