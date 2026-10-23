#!/usr/bin/env node
// The provider-kit command. It only silences Node's notice that node:sqlite is experimental (the job
// store uses it, deliberately) and then loads the CLI, which is in main.ts.

process.removeAllListeners("warning").on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  console.warn(`${warning.name}: ${warning.message}`);
});

await import("./main.js");
