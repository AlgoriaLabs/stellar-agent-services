#!/usr/bin/env node
// The verifier command. Everything is in main.ts; this only connects it to the process.

import { main } from "./main.js";
import { processIo } from "./shared.js";

process.exitCode = await main(process.argv.slice(2), processIo());
