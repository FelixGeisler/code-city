import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

const viewerRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: viewerRoot,
  base: "./",
  publicDir: false,
  build: {
    assetsInlineLimit: 0,
    outDir: fileURLToPath(new URL("../../build/viewer", import.meta.url)),
    emptyOutDir: true,
  },
});
