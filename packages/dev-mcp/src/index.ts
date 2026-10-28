#!/usr/bin/env node
// The MCP server over stdio. Everything is in server.ts; this only connects it to the process.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

await createServer().connect(new StdioServerTransport());
