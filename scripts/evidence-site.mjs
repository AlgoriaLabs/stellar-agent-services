// Builds the public evidence site from an explicit list of captured artifacts, excluding private runtime state.
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { anchorProblems } from "../packages/verifier/dist/publish.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error("Usage: node scripts/evidence-site.mjs <empty-output-directory>");
const target = resolve(output);
await mkdir(target, { recursive: true });
if ((await readdir(target)).length) throw new Error("The output directory must be empty; no existing files are overwritten.");

const manifest = await readFile(join(root, "evidence/checksums.sha256"), "utf8");
const paths = [];
for (const line of manifest.trim().split("\n")) {
  const match = /^([a-f0-9]{64})  (evidence\/(?:d[12]\/[^/]+\.(?:jpg|mp4|json)|validation\/[a-z0-9-]+\.json|receipts\/[a-f0-9]{64}(?:\.[a-z0-9-]+)?\.(?:json|svg)))$/.exec(line);
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
  const registryPath = "validation/oracle-testnet-records.json";
  const registry = paths.includes(registryPath) ? JSON.parse(await readFile(join(target, registryPath), "utf8")) : undefined;
  const anchored = registry?.network === receipt.network && registry?.requestHash &&
    anchorProblems(registry.registryRecord, receipt, stem.slice("receipts/".length)).length === 0 &&
    registry.events.some(event => event.topic[0] === "validation_response" &&
      registry.transactions.some(tx => tx.transaction === event.transaction && tx.status === "SUCCESS"));
  if (badgePaths.some(each => each.endsWith(".8004-validated.svg")) && !anchored) {
    throw new Error("The 8004 badge has no matching confirmed registry evidence.");
  }
  const oracle = receipt.agentId === 163;
  receiptSection = `<section aria-labelledby="verification">
    <h2 id="verification">D2 · Live verification receipt and badges</h2>
    <p>The actual HTTPS sample was checked with a dedicated testnet payer. Latest check:
      <time>${escape(receipt.checkedAt)}</time>. This run reached <strong>level ${escape(receipt.level)}</strong>
      (conformance score ${escape(receipt.score)}). The individual checks below also show failures or skips;
      the conformance level does not certify identity or load.</p>
    <p>${badgePaths.map(each => `<a href="${path}"><img src="${each}" alt="${escape(each.slice(stem.length + 1, -4).replaceAll("-", " "))}: testnet"></a>`).join(" ")}</p>
    <ul>${receipt.results.map(result => `<li><strong>${escape(result.check)}: ${escape(result.status)}</strong>${result.reason ? ` — ${escape(result.reason)}` : ""}${result.findings?.filter(each => each.severity === "fail").map(each => ` — [${escape(each.rule)}] ${escape(each.message)}`).join("") ?? ""}</li>`).join("")}</ul>
    <p><a href="${path}">Canonical verification receipt</a> ·
      <a href="${oracle ? "d2/oracle-live-verification.json" : "d2/live-verification.json"}">Run report and captured manifest</a> ·
      <a href="${oracle ? "d2/oracle-payments.json" : "d2/verification-payments.json"}">Independent payment proofs</a></p>
    <p class="rule">${oracle ? `The sample runs on the existing Oracle VM as registered testnet agent 163.
      <a href="https://sas-testnet.79-76-99-174.sslip.io/.well-known/stellar-agent-services.json">Live manifest</a> ·
      <a href="${registryPath}">Confirmed registry records</a>.
      ${anchored ? "The Validation Registry response anchors this exact receipt and earns the 8004 validated badge." : "The validation request is confirmed; the response is pending."}` : "This historical receipt used a temporary, unregistered endpoint and is unanchored."}
      The validator is operated for this project; this is not an independent audit or pilot.</p>
    <p class="rule">The verifier run used the repository checkout. The client polling fix is not yet released to npm.</p>
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
