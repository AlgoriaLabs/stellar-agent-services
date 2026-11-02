// Copies the documents the MCP server reads into repository/, at their repository paths, before npm packs the package
// (prepack). Installed from npm, the server has no clone to read: it reads this copy, made from the same commit as its
// code. The set is llms.txt and every repository file it links to, as src/docs.ts reads them.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAW = "https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/main/";
const LINK = /^- \[[^\]]+\]\(([^)]+)\)/;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = fileURLToPath(new URL("../repository/", import.meta.url));

const index = readFileSync(join(root, "llms.txt"), "utf8");
const paths = ["llms.txt"];
for (const line of index.split("\n")) {
  const url = LINK.exec(line)?.[1];
  if (url?.startsWith(RAW)) paths.push(url.slice(RAW.length));
}
const missing = paths.filter((path) => !existsSync(join(root, path)));
if (missing.length > 0) {
  console.error(`pack-docs: llms.txt links to files that don't exist: ${missing.join(", ")}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
for (const path of paths) {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  copyFileSync(join(root, path), join(out, path));
}
console.log(`pack-docs: ${paths.length} documents in repository/`);
