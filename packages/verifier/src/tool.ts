// What identifies this verifier: the User-Agent of its requests, so providers can tell a verification
// run in their logs, and the `tool` of the receipts it issues. The version is the installed package's own.

import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export const TOOL = { name: "@stellar-agent-services/verifier", version } as const;

export const USER_AGENT = `stellar-agent-services-verifier/${TOOL.version} (+https://github.com/AlgoriaLabs/stellar-agent-services)`;
