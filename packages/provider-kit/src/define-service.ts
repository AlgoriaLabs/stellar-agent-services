// defineService(): one paid service.
//
// PoC: price, schemas, capacity and handler. The input is validated before any 402 [P8] and the
// handler's output before settling or storing it [S1]. An "on-success" service must declare
// expectedDurationSeconds [S2]; createProvider() checks it against maxTimeoutSeconds.
//
// TODO: check the examples against the schemas at startup.

import type { Charge, JsonObject } from "@stellar-agent-services/protocol";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

export interface ServiceConfig<Input extends JsonObject = JsonObject, Output extends JsonObject = JsonObject> {
  name: string;
  title?: string;
  description: string;
  /** USDC as a decimal string, such as "0.01". */
  price: string;
  /** Default "upfront". */
  charge?: Charge;
  expectedDurationSeconds?: number;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  examples?: { input: Input; output: Output }[];
  tags?: string[];
  maxInputBytes?: number;
  /** How many jobs run at once and how long new ones may queue (docs/provider-standard.md §5.8). */
  capacity?: CapacityConfig;
  /** Receives only the parsed input, never payment data. */
  handler: (input: Input, context: { signal: AbortSignal }) => Promise<Output> | Output;
}

export interface CapacityConfig {
  /** Jobs that run at the same time. Default 4. */
  concurrency?: number;
  /** Jobs that may wait for a free slot. Default 100. */
  maxQueued?: number;
  /**
   * Longest a new job may expect to wait. Beyond it, create-job answers 503 before payment. Default 60;
   * 0 means no queue. An "on-success" job also has to finish before its payment expires [S2], which
   * can lower it.
   */
  maxQueueWaitSeconds?: number;
}

export const DEFAULT_CAPACITY: Readonly<Required<CapacityConfig>> = { concurrency: 4, maxQueued: 100, maxQueueWaitSeconds: 60 };

export interface Service extends Omit<ServiceConfig, "handler" | "charge" | "capacity"> {
  charge: Charge;
  capacity: Required<CapacityConfig>;
  /** The price in USDC base units (7 decimals). */
  amount: string;
  handler: (input: JsonObject, context: { signal: AbortSignal }) => Promise<JsonObject> | JsonObject;
  validateInput: ValidateFunction;
  validateOutput: ValidateFunction;
}

/** USDC has 7 decimals on Stellar. */
const USDC_DECIMALS = 7;

export function defineService<Input extends JsonObject, Output extends JsonObject>(
  config: ServiceConfig<Input, Output>,
): Service {
  // Service schemas are written by the provider, so unknown keywords are ignored, as JSON Schema intends.
  if (config.charge === "on-success" && config.expectedDurationSeconds === undefined) {
    throw new TypeError(`service "${config.name}": an on-success service must set expectedDurationSeconds [S2]`);
  }
  const capacity = { ...DEFAULT_CAPACITY, ...config.capacity };
  if (!Number.isInteger(capacity.concurrency) || capacity.concurrency < 1) {
    throw new RangeError(`service "${config.name}": capacity.concurrency must be a whole number of at least 1`);
  }
  for (const field of ["maxQueued", "maxQueueWaitSeconds"] as const) {
    if (!Number.isInteger(capacity[field]) || capacity[field] < 0) {
      throw new RangeError(`service "${config.name}": capacity.${field} must be a whole number of at least 0`);
    }
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  return {
    ...config,
    charge: config.charge ?? "upfront",
    capacity,
    amount: toBaseUnits(config.price),
    handler: config.handler as unknown as Service["handler"],
    validateInput: ajv.compile(config.inputSchema),
    validateOutput: ajv.compile(config.outputSchema),
  };
}

/** "0.01" -> "100000", without float math. */
export function toBaseUnits(decimal: string): string {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(decimal);
  if (match === null) throw new TypeError(`price must be a decimal with at most ${USDC_DECIMALS} places: "${decimal}"`);
  const units = BigInt(match[1]! + (match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  if (units <= 0n) throw new TypeError("price must be above zero");
  return units.toString();
}
