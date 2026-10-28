// Node's Buffer for the Ledger wallet module, set before any module that needs it is evaluated:
// main.ts imports this file first.

import { Buffer } from "buffer";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
