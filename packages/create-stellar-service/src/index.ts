#!/usr/bin/env node
// The create-stellar-service command, which `npm create stellar-service` runs. The work is in main.ts.

import { Cancelled, create, USAGE, UsageError } from "./main.js";

create(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof Cancelled) {
      console.error("\nCancelled.");
      process.exitCode = 130;
      return;
    }
    if (error instanceof UsageError || (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"))) {
      console.error(`create-stellar-service: ${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    console.error(`create-stellar-service: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
