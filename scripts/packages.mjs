// The npm packages: what each would publish, their one shared version, a rehearsal on a throwaway registry, and the
// publish itself. They are released together, at one version: a project made by create-stellar-service x.y.z depends
// on provider-kit x.y.z.
//
//   node scripts/packages.mjs check                  each package as npm would pack it: its files and metadata
//   node scripts/packages.mjs version <x.y.z>        sets that version on every package, and on the dependencies on it
//   node scripts/packages.mjs rehearse               publishes them to a throwaway local registry (Verdaccio), installs
//                                                    them from it, and checks projects the published scaffolder makes
//   node scripts/packages.mjs publish [--dry-run]    publishes each package not on npm at its version yet, dependencies
//                                                    first, with provenance when run by GitHub Actions (release.yml)
//
// Run after `npm run build`. ci.yml runs check and rehearse; release.yml runs publish.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VERDACCIO = "verdaccio@6.10.3";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Files a package needs at run time beyond its exports and bins: each is read from disk by the code. */
const SHIPS = {
  "@stellar-agent-services/protocol": ["schemas/manifest.schema.json", "test-vectors/README.md"],
  "@stellar-agent-services/provider-kit": ["dist/approve/index.html", "schemas/gateway-config.schema.json"],
  "@stellar-agent-services/dev-mcp": ["repository/llms.txt", "repository/AGENTS.md", "repository/docs/provider-standard.md"],
  "create-stellar-service": ["templates/typescript/src/server.ts", "templates/python/app.py", "templates/gateway/Dockerfile", "templates/fly/fly.toml"],
};
/** Never published: settings, keys, journals, job databases, tests and build state. */
const NEVER = [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, /\.(sqlite|db)(-\w+)?$/, /\.journal\.jsonl$/, /(^|\/)test\//, /\.tsbuildinfo$/, /(^|\/)node_modules\//];

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "check") check();
  else if (command === "version") version(args[0]);
  else if (command === "rehearse") await rehearse();
  else if (command === "publish") publish({ dryRun: args.includes("--dry-run") });
  else {
    console.error("usage: node scripts/packages.mjs check | version <x.y.z> | rehearse | publish [--dry-run]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

/** The packages npm gets: every workspace under packages/, each after the ones it depends on. */
function packages() {
  const all = readJson(join(ROOT, "package.json"))
    .workspaces.filter((dir) => dir.startsWith("packages/"))
    .map((dir) => ({ dir, path: join(ROOT, dir), json: readJson(join(ROOT, dir, "package.json")) }));
  const ordered = [];
  const visit = (pkg) => {
    if (ordered.includes(pkg)) return;
    for (const name of internal(pkg.json, all)) visit(all.find((other) => other.json.name === name));
    ordered.push(pkg);
  };
  all.forEach(visit);
  return ordered;
}

/** The names of the other packages this one depends on. */
function internal(json, all) {
  const names = new Set(all.map((pkg) => pkg.json.name));
  return Object.keys({ ...json.dependencies, ...json.peerDependencies, ...json.optionalDependencies }).filter((name) => names.has(name));
}

function check() {
  const all = packages();
  const problems = [];
  const versions = new Set(all.map((pkg) => pkg.json.version));
  if (versions.size !== 1) problems.push(`the packages are at different versions (${[...versions].join(", ")}): run version <x.y.z>`);
  console.log("Package".padEnd(40), "Version".padEnd(9), "Files".padStart(5), "Unpacked".padStart(10));
  for (const pkg of all) {
    const { json } = pkg;
    const own = (message) => problems.push(`${json.name}: ${message}`);
    for (const name of internal(json, all)) {
      if (json.dependencies?.[name] !== json.version) own(`depends on ${name} "${json.dependencies?.[name]}": every package is released at ${json.version}`);
    }
    if (json.license !== "MIT") own(`license is ${json.license}`);
    if (!json.engines?.node) own("no engines.node: npm can't warn a user whose Node.js is too old");
    if (json.repository?.directory !== pkg.dir) own(`repository.directory is ${json.repository?.directory}, not ${pkg.dir}: npm links the wrong folder`);
    if (json.type !== "module") own("isn't an ES module package");

    const packed = pack(pkg.path);
    const files = new Set(packed.files.map((file) => file.path));
    const needed = ["package.json", "README.md", "LICENSE", ...targets(json.exports), ...Object.values(json.bin ?? {}).map(clean), ...(SHIPS[json.name] ?? [])];
    for (const file of needed) if (!matches(file, files)) own(`wouldn't publish ${file}`);
    for (const file of files) if (NEVER.some((pattern) => pattern.test(file))) own(`would publish ${file}`);
    for (const bin of Object.values(json.bin ?? {})) {
      const path = join(pkg.path, clean(bin));
      if (existsSync(path) && !readFileSync(path, "utf8").startsWith("#!/usr/bin/env node")) own(`${clean(bin)} doesn't start with #!/usr/bin/env node`);
    }
    const note = json.private ? "  private: npm publish refuses it until \"private\" is removed" : "";
    console.log(json.name.padEnd(40), json.version.padEnd(9), String(files.size).padStart(5), `${Math.round(packed.unpackedSize / 1024)} kB`.padStart(10), note);
  }
  if (problems.length > 0) throw new Error(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  console.log("\n✓ Every package would publish what it needs, and nothing it shouldn't.");
}

/** What `npm pack` would put in the tarball, without writing it. Runs prepack, as a publish does. */
function pack(path) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: path, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`npm pack failed in ${path}:\n${result.stderr}`);
  // A prepack script may print before npm's JSON.
  const json = result.stdout.slice(result.stdout.search(/^\[/m));
  return JSON.parse(json)[0];
}

/** Every file an exports map points to. */
function targets(exports) {
  if (typeof exports === "string") return [clean(exports)];
  if (exports === null || typeof exports !== "object") return [];
  return Object.values(exports).flatMap(targets);
}

/** Whether a packed file is this path, or, for an exports pattern such as test-vectors/*, any file it maps. */
function matches(path, files) {
  if (!path.includes("*")) return files.has(path);
  const pattern = new RegExp(`^${path.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`);
  return [...files].some((file) => pattern.test(file));
}

function clean(path) {
  return path.replace(/^\.\//, "");
}

function version(next) {
  if (next === undefined || !SEMVER.test(next)) throw new Error(`version takes a version such as 0.1.0, not ${next}`);
  const all = packages();
  const names = new Set(all.map((pkg) => pkg.json.name));
  // Every workspace, so the examples and the wallet keep depending on the packages beside them.
  for (const dir of readJson(join(ROOT, "package.json")).workspaces) {
    const file = join(ROOT, dir, "package.json");
    const json = readJson(file);
    if (names.has(json.name)) json.version = next;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(json[field] ?? {})) if (names.has(name)) json[field][name] = next;
    }
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: ROOT });
  console.log(`\n✓ Every package is at ${next}, and package-lock.json too. Next: commit, then tag v${next} and push the tag.`);
}

function publish({ dryRun }) {
  check();
  const all = packages();
  const { version } = all[0].json;
  if (process.env["GITHUB_REF_TYPE"] === "tag" && process.env["GITHUB_REF_NAME"] !== `v${version}`) {
    throw new Error(`the tag is ${process.env["GITHUB_REF_NAME"]}, but the packages are at ${version}: tag v${version}`);
  }
  const closed = all.filter((pkg) => pkg.json.private).map((pkg) => pkg.json.name);
  if (closed.length > 0) throw new Error(`still private: ${closed.join(", ")}. Remove "private": true from each to publish them.`);
  // A prerelease, such as 0.2.0-rc.1, goes out under "next", so `npm install` keeps getting the last release.
  const tag = version.includes("-") ? "next" : "latest";
  const provenance = process.env["GITHUB_ACTIONS"] === "true" ? ["--provenance"] : [];
  for (const pkg of all) {
    if (published(pkg.json.name, version)) {
      console.log(`  ${pkg.json.name}@${version} is on npm already`);
      continue;
    }
    run("npm", ["publish", "--workspace", pkg.dir, "--access", "public", "--tag", tag, ...provenance, ...(dryRun ? ["--dry-run"] : [])], { cwd: ROOT });
  }
  console.log(`\n✓ ${dryRun ? "Would publish" : "Published"} ${all.length} packages at ${version} under "${tag}".`);
}

/** Whether npm has this version. Anything but a clear yes or a clear 404 stops the publish. */
function published(name, version, env = process.env) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], { cwd: ROOT, encoding: "utf8", env });
  if (result.status === 0) return result.stdout.trim() !== "";
  if (/E404|404 Not Found/.test(result.stderr)) return false;
  throw new Error(`can't tell whether ${name}@${version} is on npm:\n${result.stderr}`);
}

async function rehearse() {
  check();
  const all = packages();
  const { version } = all[0].json;
  const work = mkdtempSync(join(tmpdir(), "packages-rehearsal-"));
  const stops = [];
  try {
    const registry = await startRegistry(work, stops);
    const env = await registryEnv(registry, work);

    console.log(`\nPublishing to ${registry}, a registry on this computer that's gone when the rehearsal ends`);
    for (const pkg of all) {
      // The packed tarball, as npm would publish it, with "private" taken out: this registry is a throwaway.
      const result = spawnSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: pkg.path, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`npm pack failed for ${pkg.json.name}:\n${result.stderr}`);
      const tarball = join(work, JSON.parse(result.stdout.slice(result.stdout.search(/^\[/m)))[0].filename);
      const folder = join(work, "unpacked", pkg.json.name);
      mkdirSync(folder, { recursive: true });
      run("tar", ["-xzf", tarball, "-C", folder]);
      const manifest = join(folder, "package", "package.json");
      const json = readJson(manifest);
      delete json.private;
      writeFileSync(manifest, `${JSON.stringify(json, null, 2)}\n`);
      run("npm", ["publish", join(folder, "package"), "--ignore-scripts", "--registry", registry], { env, quiet: true });
      console.log(`  ✓ ${pkg.json.name}@${version}`);
    }

    await installed(all, version, env, work);

    const scaffolder = `npm exec --yes --package=create-stellar-service@${version} -- create-stellar-service`;
    for (const [kind, network] of [["wrap", "testnet"], ["typescript", "mainnet"], ["python", "mainnet"]]) {
      run(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "scripts/scaffold-check.mjs"), "--kind", kind, "--network", network, "--kit", "npm", "--scaffolder", scaffolder], { env });
    }
    console.log(`\n✓ Rehearsed: every package at ${version} installs from a registry and works, and so do the projects create-stellar-service makes.`);
  } finally {
    for (const stop of stops.reverse()) await stop();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Verdaccio on 127.0.0.1: these packages stay on it, everything else comes from npm through it. */
async function startRegistry(work, stops) {
  const port = await freePort();
  const config = join(work, "verdaccio.yaml");
  writeFileSync(
    config,
    [
      `storage: ${join(work, "storage")}`,
      "auth:",
      "  htpasswd:",
      `    file: ${join(work, "htpasswd")}`,
      "    max_users: 10",
      "uplinks:",
      "  npmjs:",
      "    url: https://registry.npmjs.org/",
      "packages:",
      "  '@stellar-agent-services/*':",
      "    access: $all",
      "    publish: $authenticated",
      "  'create-stellar-service':",
      "    access: $all",
      "    publish: $authenticated",
      "  '**':",
      "    access: $all",
      "    publish: $authenticated",
      "    proxy: npmjs",
      "max_body_size: 50mb",
      "web:",
      "  enable: false",
      "log: { type: stdout, format: pretty, level: warn }",
      "",
    ].join("\n"),
  );
  const child = spawn("npx", ["--yes", VERDACCIO, "--config", config, "--listen", `127.0.0.1:${port}`], { stdio: ["ignore", "inherit", "inherit"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  stops.push(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Verdaccio exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}-/ping`)).ok) return url;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Verdaccio didn't answer at ${url} in 3 minutes`);
}

/** A user on the throwaway registry, and npm settings that send every command to it. */
async function registryEnv(registry, work) {
  const password = crypto.randomUUID();
  const response = await fetch(`${registry}-/user/org.couchdb.user:rehearsal`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "rehearsal", password, type: "user", roles: [] }),
  });
  const { token } = await response.json();
  if (!token) throw new Error(`the registry made no user (${response.status})`);
  const npmrc = join(work, "npmrc");
  writeFileSync(npmrc, `registry=${registry}\n${registry.replace(/^http:/, "")}:_authToken=${token}\n`);
  return { ...process.env, npm_config_userconfig: npmrc, npm_config_registry: registry, npm_config_cache: join(work, "cache") };
}

/** Installs the published packages into an empty project, and uses each: imports, commands, the MCP server's documents. */
async function installed(all, version, env, work) {
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  const libraries = all.filter((pkg) => pkg.json.name.startsWith("@stellar-agent-services/")).map((pkg) => `${pkg.json.name}@${version}`);
  console.log(`\nInstalling ${libraries.join(", ")} into an empty project`);
  run("npm", ["install", "--no-audit", "--no-fund", ...libraries], { cwd: consumer, env, quiet: true });

  for (const bin of ["provider-kit", "verifier", "stellar-pay"]) {
    run(join(consumer, "node_modules/.bin", bin), ["--help"], { cwd: consumer, env, quiet: true });
    console.log(`  ✓ ${bin} --help`);
  }
  const imports = all.filter((pkg) => pkg.json.exports !== undefined).map((pkg) => pkg.json.name);
  const script = `for (const name of ${JSON.stringify(imports)}) await import(name);
const { TOOL } = await import("@stellar-agent-services/verifier");
if (TOOL.version !== ${JSON.stringify(version)}) throw new Error("the verifier says it is " + TOOL.version);`;
  run(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { cwd: consumer, env, quiet: true });
  console.log(`  ✓ imports ${imports.join(", ")}; the verifier's receipts name ${version}`);

  // The MCP server, installed: it reads the documents packed with it, as a coding agent's client would ask.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "rehearsal", version });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(consumer, "node_modules/@stellar-agent-services/dev-mcp/dist/index.js")], stderr: "inherit" }));
  try {
    const doc = await client.callTool({ name: "read_doc", arguments: { path: "AGENTS.md" } });
    const rule = await client.callTool({ name: "get_spec_rule", arguments: { id: "J13" } });
    const text = (result) => result.content.map((part) => part.text ?? "").join("\n");
    if (doc.isError || !text(doc).includes("Rules you must not break")) throw new Error(`the MCP server can't read AGENTS.md: ${text(doc).slice(0, 300)}`);
    if (rule.isError || !text(rule).includes("J13")) throw new Error(`the MCP server can't find rule J13: ${text(rule).slice(0, 300)}`);
    if (client.getServerVersion()?.version !== version) throw new Error(`the MCP server says it is ${client.getServerVersion()?.version}`);
  } finally {
    await client.close();
  }
  console.log("  ✓ stellar-agent-services-mcp reads AGENTS.md and the spec's rules from its own package");

  // What a plain install brings, with none of the overrides create-stellar-service writes: how many Stellar SDKs, and
  // what npm audit says about the packages' dependencies. Both are warnings: the causes sit in other packages, and the
  // advisories change from day to day.
  const warn = (title, message) => console.log(process.env["GITHUB_ACTIONS"] === "true" ? `::warning title=${title}::${message}` : `  ! ${message}`);
  const listed = spawnSync("npm", ["ls", "@stellar/stellar-sdk", "--all", "--json"], { cwd: consumer, encoding: "utf8", env });
  const sdks = new Set();
  const walk = (node) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (name === "@stellar/stellar-sdk" && dep.version) sdks.add(dep.version);
      walk(dep);
    }
  };
  walk(JSON.parse(listed.stdout || "{}"));
  if (sdks.size > 1) {
    warn("Two Stellar SDKs", `Installed without overrides, the packages bring ${sdks.size} Stellar SDKs (${[...sdks].join(", ")}): @trionlabs/stellar8004 asks for another version. Nothing breaks, but the second copy adds size and its own dependencies. A project avoids it with the overrides create-stellar-service writes.`);
  } else console.log(`  ✓ one Stellar SDK: ${[...sdks].join("")}`);

  // The advisories come from npm itself: this registry only holds the packages.
  const audit = spawnSync("npm", ["audit", "--omit=dev", "--json", "--registry", "https://registry.npmjs.org/"], { cwd: consumer, encoding: "utf8", env });
  const found = Object.values(JSON.parse(audit.stdout || "{}").vulnerabilities ?? {}).filter((entry) => entry.via.some((via) => typeof via === "object"));
  if (audit.stdout === "" || audit.error) warn("npm audit didn't run", (audit.stderr || String(audit.error)).slice(0, 300));
  else if (found.length > 0) {
    const listed = found.map((entry) => `${entry.name} ${entry.range} (${entry.severity}) in ${entry.nodes.join(", ")}`).join("; ");
    warn("npm audit", `A plain install of the packages has known vulnerabilities in ${found.length} dependencies: ${listed}`);
  } else console.log("  ✓ npm audit finds nothing in a plain install");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function run(command, args, options = {}) {
  const { quiet, ...rest } = options;
  if (!quiet) console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { ...rest, encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed (${result.error?.message ?? `exit ${result.status}`})${quiet ? `:\n${result.stdout ?? ""}${result.stderr ?? ""}` : ""}`);
  }
  return result;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
