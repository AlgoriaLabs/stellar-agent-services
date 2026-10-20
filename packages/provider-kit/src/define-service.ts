// defineService(): one paid service.
//
// TODO:
// - Input: { id, title, description, mode: "sync" | "async", price (USDC string, converted to base
//   units with 7 decimals and no float math), input / output JSON Schemas, example, handler,
//   settlement?: "after-work" | "before-work" }.
// - Validate the handler's input before running it, and its output before storing or returning it.
// - The handler receives only the parsed input and an AbortSignal, never payment data.

export {};
