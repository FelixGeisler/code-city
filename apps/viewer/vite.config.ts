import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

const viewerRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: viewerRoot,
  base: "./",
  publicDir: false,
  optimizeDeps: {
    // Pre-bundle every browser dependency and subpath before serving modules.
    // Late discovery otherwise invalidates an already-served URL with a 504.
    noDiscovery: true,
    include: [
      "fflate",
      "three",
      "three/addons/controls/OrbitControls.js",
    ],
  },
  build: {
    assetsInlineLimit: 0,
    outDir: fileURLToPath(new URL("../../build/viewer", import.meta.url)),
    emptyOutDir: true,
  },
});
