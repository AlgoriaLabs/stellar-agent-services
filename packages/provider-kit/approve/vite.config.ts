import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

// The approval page that `provider-kit trustline`, `register` and `request-validation` open
// (src/cli/approval.ts). `vite build` writes plain files to dist/approve, which the CLI serves on
// 127.0.0.1. Everything it runs is in that bundle: it loads no scripts from anywhere else.
//
// The bundle ships in provider-kit's MIT package, so the build fails if it would hold copyleft code.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [svelte(), noCopyleft()],
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

/**
 * Fails the build when a package licensed GPL, LGPL or AGPL, with no other choice, has code in the bundle, such as
 * LOBSTR's wallet connector (src/lib/wallet.ts). It reads the license of each package the bundle's modules come from.
 */
function noCopyleft(): Plugin {
  return {
    name: "provider-kit:no-copyleft",
    apply: "build",
    generateBundle(_options, bundle) {
      const licenses = new Map<string, string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of new Set([...output.moduleIds, ...Object.keys(output.modules)])) {
          const root = packageRoot(id);
          if (root !== undefined && !licenses.has(root)) licenses.set(root, licenseOf(root));
        }
      }
      const copyleft = [...licenses].filter(([, license]) => isCopyleft(license));
      if (copyleft.length > 0) {
        this.error(`copyleft code would ship in provider-kit's MIT package:\n${copyleft.map(([root, license]) => `  ${root} (${license})`).join("\n")}`);
      }
    },
  };
}

/** The directory of the npm package a module comes from, or undefined for the page's own code. */
function packageRoot(id: string): string | undefined {
  const path = id.split("?")[0]!.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  if (at === -1) return undefined;
  const parts = path.slice(at + marker.length).split("/");
  const name = parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
  return `${path.slice(0, at + marker.length)}${name}`;
}

function licenseOf(root: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { license?: unknown; licenses?: { type?: string }[] };
    if (typeof manifest.license === "string") return manifest.license;
    return manifest.licenses?.map((license) => license.type ?? "").join(" OR ") ?? "none";
  } catch {
    return "unreadable";
  }
}

/** Copyleft unless an SPDX "OR" offers a choice that isn't. */
function isCopyleft(license: string): boolean {
  return license
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/i)
    .every((choice) => /GPL/i.test(choice));
}
