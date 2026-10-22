import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// A static page with no backend (docs/payment-client.md, "Web app"): `vite build` writes plain files to
// dist/, which any static host can serve.
export default defineConfig({
  plugins: [svelte()],
  // The Stellar SDK and Ajv are most of the bundle: about 680 kB, 190 kB gzipped.
  build: { target: "es2022", chunkSizeWarningLimit: 800 },
});
