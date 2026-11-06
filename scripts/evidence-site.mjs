// Builds the public evidence site from an explicit list of captured artifacts, excluding private runtime state.
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error("Usage: node scripts/evidence-site.mjs <empty-output-directory>");
const target = resolve(output);
await mkdir(target, { recursive: true });
if ((await readdir(target)).length) throw new Error("The output directory must be empty; no existing files are overwritten.");

const manifest = await readFile(join(root, "evidence/checksums.sha256"), "utf8");
const paths = [];
for (const line of manifest.trim().split("\n")) {
  const match = /^([a-f0-9]{64})  (evidence\/(?:d[12]\/[^/]+\.(?:jpg|mp4|json)|receipts\/[a-f0-9]{64}(?:\.[a-z0-9-]+)?\.(?:json|svg)))$/.exec(line);
  if (!match) throw new Error(`Unexpected evidence checksum entry: ${line}`);
  const [, hash, path] = match;
  const bytes = await readFile(join(root, path));
  if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error(`Checksum mismatch: ${path}`);
  const destination = join(target, path.slice("evidence/".length));
  await mkdir(resolve(destination, ".."), { recursive: true });
  await copyFile(join(root, path), destination);
  paths.push(path.slice("evidence/".length));
}

const escape = value => String(value).replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
const receipts = await Promise.all(paths.filter(path => /^receipts\/[a-f0-9]{64}\.json$/.test(path)).map(async path => ({
  path, receipt: JSON.parse(await readFile(join(target, path), "utf8")),
})));
receipts.sort((a, b) => b.receipt.checkedAt.localeCompare(a.receipt.checkedAt));
let receiptSection = "";
if (receipts.length) {
  const { path, receipt } = receipts[0];
  const stem = path.slice(0, -5);
  const badgePaths = paths.filter(each => each.startsWith(`${stem}.`) && each.endsWith(".svg"));
  receiptSection = `<section aria-labelledby="verification">
    <h2 id="verification">D2 · Live verification receipt and badges</h2>
    <p>The actual HTTPS sample was checked with a dedicated testnet payer. Latest check:
      <time>${escape(receipt.checkedAt)}</time>. This run reached <strong>level ${escape(receipt.level)}</strong>
      (conformance score ${escape(receipt.score)}). The individual checks below also show failures or skips;
      the conformance level does not certify identity or load.</p>
    <p>${badgePaths.map(each => `<a href="${path}"><img src="${each}" alt="${escape(each.slice(stem.length + 1, -4).replaceAll("-", " "))}: testnet"></a>`).join(" ")}</p>
    <ul>${receipt.results.map(result => `<li><strong>${escape(result.check)}: ${escape(result.status)}</strong>${result.reason ? ` — ${escape(result.reason)}` : ""}${result.findings?.filter(each => each.severity === "fail").map(each => ` — [${escape(each.rule)}] ${escape(each.message)}`).join("") ?? ""}</li>`).join("")}</ul>
    <p><a href="${path}">Canonical verification receipt</a> ·
      <a href="d2/live-verification.json">Run report and captured manifest</a> ·
      <a href="d2/verification-payments.json">Independent payment proofs</a></p>
    <p class="rule">The HTTPS endpoint used a temporary tunnel and was not registered. The receipt is unanchored:
      no Validation Registry response or 8004 validated badge is claimed. The validator is operated for this
      project; this is not an independent audit. An owner-approved permanent sample registration and a fresh
      verification run are required for the registry evidence.</p>
    <p class="rule">The final run used local sample admission and verifier polling fixes based on the 0.1.0
      checkout. Those changes have not been released to npm.</p>
    ${receipts.slice(1).map(previous => `<p class="details"><a href="${previous.path}">Earlier receipt (${escape(previous.receipt.checkedAt)})</a>: ${previous.receipt.results.filter(each => each.status !== "passed").map(each => `${escape(each.check)} ${escape(each.status)}`).join("; ")}. Preserved without editing.</p>`).join("")}
  </section>`;
}
const template = await readFile(join(root, "evidence/index.html"), "utf8");
if (!template.includes("<!-- live-verification -->")) throw new Error("The page is missing its live receipt section marker.");
await writeFile(join(target, "index.html"), template.replace("<!-- live-verification -->", receiptSection));
await writeFile(join(target, ".nojekyll"), "");
await writeFile(join(target, "checksums.sha256"), manifest.replaceAll("  evidence/", "  "));

// Ensure every local media/proof link resolves before publishing the page.
const html = await readFile(join(target, "index.html"), "utf8");
for (const [, attribute] of html.matchAll(/(?:href|src|poster)="([^"]+)"/g)) {
  if (/^(?:https?:|#)/.test(attribute)) continue;
  await readFile(join(target, attribute));
}
console.log(`Built ${basename(target)}: ${paths.length} verified artifacts, index.html and checksums.sha256.`);
