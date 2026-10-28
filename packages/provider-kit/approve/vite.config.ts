import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The approval page that `provider-kit trustline`, `register` and `request-validation` open
// (src/cli/approval.ts). `vite build` writes plain files to dist/approve, which the CLI serves on
// 127.0.0.1. Everything it runs is in that bundle: it loads no scripts from anywhere else.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [svelte()],
  // The Ledger module's dependencies expect Node's `global`.
  define: { global: "globalThis" },
  build: {
    outDir: "../dist/approve",
    emptyOutDir: true,
    target: "es2022",
    // Stellar Wallets Kit and its wallet modules are most of the bundle. It is served from this computer.
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5174 },
});
