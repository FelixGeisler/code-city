import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

const viewerRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: viewerRoot,
  base: "./",
  publicDir: false,
  optimizeDeps: {
    // OrbitControls must be known before modules are served; discovering that
    // subpath late invalidates its already-served URL with a 504. Keep normal
    // discovery enabled so transitive CommonJS packages are also optimized.
    include: [
      "fflate",
      "ignore",
      "jsonc-parser",
      "three",
      "three/addons/controls/OrbitControls.js",
    ],
  },
  build: {
    assetsInlineLimit: 0,
    manifest: true,
    outDir: fileURLToPath(new URL("../../build/viewer", import.meta.url)),
    emptyOutDir: true,
  },
});
