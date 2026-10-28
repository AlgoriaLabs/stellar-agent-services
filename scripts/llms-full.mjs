// Writes llms-full.txt: every Markdown document llms.txt links to, outside its "Optional" section, in
// llms.txt's order. An agent that fetches this one file has the whole standard and every guide.
//
//   node scripts/llms-full.mjs           write llms-full.txt
//   node scripts/llms-full.mjs --check   exit 1 if llms-full.txt is out of date (CI)
//
// llms.txt is the only list of documents: add a document there, then run this script.

import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const RAW = "https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/main/";
const OUTPUT = "llms-full.txt";

/** The repository paths of the Markdown documents llms.txt links to, outside "## Optional". */
function documents(index) {
  const paths = [];
  let optional = false;
  for (const line of index.split("\n")) {
    if (line.startsWith("## ")) optional = line.trim() === "## Optional";
    const link = /^- \[[^\]]+\]\(([^)]+)\)/.exec(line);
    if (optional || link === null) continue;
    if (!link[1].startsWith(RAW)) throw new Error(`llms.txt links outside ${RAW}: ${link[1]}`);
    const path = link[1].slice(RAW.length);
    if (path.endsWith(".md")) paths.push(path);
  }
  return paths;
}

function build() {
  const index = readFileSync(new URL("llms.txt", ROOT), "utf8");
  const parts = [
    "# Stellar Agent Services: full documentation",
    "",
    "Generated from llms.txt by scripts/llms-full.mjs. Do not edit by hand. Relative links in each document are",
    "relative to its own path in https://github.com/AlgoriaLabs/stellar-agent-services.",
  ];
  for (const path of documents(index)) {
    const text = readFileSync(new URL(path, ROOT), "utf8").trimEnd();
    parts.push("", "", `<!-- ===== ${path} ===== -->`, "", text);
  }
  return `${parts.join("\n")}\n`;
}

const full = build();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(new URL(OUTPUT, ROOT), "utf8");
  } catch {
    // Missing: out of date.
  }
  if (current !== full) {
    console.error(`${OUTPUT} is out of date: run npm run llms`);
    process.exit(1);
  }
} else {
  writeFileSync(new URL(OUTPUT, ROOT), full);
  console.log(`wrote ${OUTPUT} (${full.length} bytes)`);
}
