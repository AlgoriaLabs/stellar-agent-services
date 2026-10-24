// defineService(): one paid service.
//
// Price, schemas, capacity and handler. The input is validated before any 402 [P8] and the handler's
// output before settling or storing it [S1]. Mistakes a provider can make here fail at startup, with
// the service named: an on-success service without expectedDurationSeconds [S2], examples that don't
// match their schemas [S9], a name that can't be a URL segment or tool name (§3.1). createProvider()
// then checks the whole manifest against the JSON Schema and the remaining rules.

import { SERVICE_NAME_PATTERN, type Charge, type JsonObject } from "@stellar-agent-services/protocol";
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
  /**
   * Longest the handler may run before the job fails with `timeout`. Default: twice
   * expectedDurationSeconds, or 600. An on-success job also has to finish before its payment expires.
   */
  timeoutSeconds?: number;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  examples?: { input: Input; output: Output }[];
  tags?: string[];
  /** Request body limit. Default 1 MiB, the spec's default; at most 10 MiB (§3.1). */
  maxInputBytes?: number;
  /** How many jobs run at once and how long new ones may queue (docs/provider-standard.md §5.8). */
  capacity?: CapacityConfig;
  /**
   * Receives only the parsed input, never payment data. An upfront job whose worker died is run again,
   * so a handler with side effects can use `jobId` to do them once.
   */
  handler: (input: Input, context: HandlerContext) => Promise<Output> | Output;
}

export interface HandlerContext {
  /** Aborted when the job runs out of time; stop work and return. */
  signal: AbortSignal;
  jobId: string;
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

/** The spec's default request body limit, and its maximum (§3.1). */
export const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 600;

export interface Service extends Omit<ServiceConfig, "handler" | "charge" | "capacity" | "timeoutSeconds" | "maxInputBytes"> {
  charge: Charge;
  capacity: Required<CapacityConfig>;
  timeoutSeconds: number;
  /** The request body limit that is enforced; published only when the provider set it. */
  inputLimitBytes: number;
  maxInputBytes?: number;
  /** The price in USDC base units (7 decimals). */
  amount: string;
  handler: (input: JsonObject, context: HandlerContext) => Promise<JsonObject> | JsonObject;
  validateInput: ValidateFunction;
  validateOutput: ValidateFunction;
}

/** USDC has 7 decimals on Stellar. */
const USDC_DECIMALS = 7;

export function defineService<Input extends JsonObject, Output extends JsonObject>(config: ServiceConfig<Input, Output>): Service {
  const fail = (message: string): never => {
    throw new TypeError(`service "${config.name}": ${message}`);
  };
  if (!SERVICE_NAME_PATTERN.test(config.name)) fail(`the name must match ${SERVICE_NAME_PATTERN} (§3.1)`);
  if (config.charge === "on-success" && config.expectedDurationSeconds === undefined) fail("an on-success service must set expectedDurationSeconds [S2]");
  for (const field of ["expectedDurationSeconds", "timeoutSeconds"] as const) {
    const value = config[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) fail(`${field} must be a whole number of seconds, at least 1`);
  }
  const inputLimitBytes = config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (!Number.isInteger(inputLimitBytes) || inputLimitBytes < 1 || inputLimitBytes > MAX_INPUT_BYTES) {
    fail(`maxInputBytes must be a whole number from 1 to ${MAX_INPUT_BYTES}`);
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

  // Service schemas are written by the provider, so unknown keywords are ignored, as JSON Schema intends.
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  let validateInput: ValidateFunction;
  let validateOutput: ValidateFunction;
  try {
    validateInput = ajv.compile(config.inputSchema);
    validateOutput = ajv.compile(config.outputSchema);
  } catch (error) {
    return fail(`a schema does not compile: ${(error as Error).message}`);
  }
  config.examples?.forEach((example, index) => {
    if (!validateInput(example.input)) fail(`examples[${index}].input does not match inputSchema [S9]`);
    if (!validateOutput(example.output)) fail(`examples[${index}].output does not match outputSchema [S9]`);
  });

  const { timeoutSeconds, maxInputBytes: _, ...rest } = config;
  const service: Service = {
    ...rest,
    charge: config.charge ?? "upfront",
    capacity,
    timeoutSeconds: timeoutSeconds ?? (config.expectedDurationSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : config.expectedDurationSeconds * 2),
    inputLimitBytes,
    amount: toBaseUnits(config.price),
    handler: config.handler as unknown as Service["handler"],
    validateInput,
    validateOutput,
  };
  if (config.maxInputBytes !== undefined) service.maxInputBytes = config.maxInputBytes;
  return service;
}

/** "0.01" -> "100000", without float math. */
export function toBaseUnits(decimal: string): string {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(decimal);
  if (match === null) throw new TypeError(`price must be a decimal with at most ${USDC_DECIMALS} places: "${decimal}"`);
  const units = BigInt(match[1]! + (match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  if (units <= 0n) throw new TypeError("price must be above zero");
  return units.toString();
}
