// Where a new project gets the Provider Kit.
//
// Run from a clone of this repository, the scaffolder packs the kit's packages into the project's vendor/ folder,
// since they aren't on npm yet. The project then installs and builds by itself, on another computer or in Docker too.
// Installed from npm, the project depends on the kit version released with this scaffolder.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The kit's packages: the Provider Kit and the two it depends on. */
export const KIT_PACKAGES = ["protocol", "payment-client", "provider-kit"] as const;

/**
 * The repository's npm overrides, which a project needs as well: @trionlabs/stellar8004 asks for the Stellar SDK 15,
 * and two copies of the SDK can't read each other's XDR. axios is the fixed version (IMPLEMENTATION_PLAN.md).
 */
export const OVERRIDES = { "@stellar/stellar-sdk": "16.3.1", axios: "1.20.0" } as const;

/** The provider-kit command inside a project, run with node. */
export const KIT_CLI = "node_modules/@stellar-agent-services/provider-kit/dist/cli/index.js";

export type KitSource = { from: "clone"; packages: string } | { from: "npm"; version: string };

/** The clone this scaffolder runs from, or else the version on npm. `here` is a file in this package. */
export function kitSource(here: string = import.meta.url): KitSource {
  const root = fileURLToPath(new URL("../", here));
  const packages = join(root, "..");
  if (KIT_PACKAGES.every((name) => existsSync(join(packages, name, "package.json")))) return { from: "clone", packages };
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  return { from: "npm", version: own.version };
}

/** What a clone must have built before its packages can be packed: each package's dist, and the approval page. */
export function unbuilt(packages: string): string[] {
  const needed = [...KIT_PACKAGES.map((name) => join(name, "dist", "index.js")), join("provider-kit", "dist", "approve", "index.html")];
  return needed.filter((path) => !existsSync(join(packages, path)));
}

/** The project's dependencies on the kit: the released version, or each package's file in vendor/, as packed. */
export function kitDependencies(source: KitSource, packed: Partial<Record<(typeof KIT_PACKAGES)[number], string>> = {}): Record<string, string> {
  if (source.from === "npm") return { "@stellar-agent-services/provider-kit": source.version };
  return Object.fromEntries(
    KIT_PACKAGES.map((name) => {
      const file = packed[name];
      if (file === undefined) throw new Error(`${name} wasn't packed`);
      return [`@stellar-agent-services/${name}`, `file:vendor/${file}`];
    }),
  );
}
