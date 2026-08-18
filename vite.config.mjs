import { defineConfig } from "vite";

export default defineConfig({
  base: "/code-city/",
  publicDir: false,
  build: {
    assetsInlineLimit: 0,
    emptyOutDir: true,
    sourcemap: false,
  },
  worker: {
    format: "es",
  },
});
