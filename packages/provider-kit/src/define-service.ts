// defineService(): one paid service.
//
// TODO:
// - Input: { name, title?, description, price (USDC string such as "0.01", converted to base units
//   with 7 decimals and no float math), charge?: "on-success" | "upfront" (default "upfront"),
//   expectedDurationSeconds?, inputSchema, outputSchema, examples?, tags?, maxInputBytes?, handler }.
//   Field names follow the manifest, which follows MCP tool names.
// - Refuse "on-success" when expectedDurationSeconds is above half of maxTimeoutSeconds [S2].
// - Check the examples against the schemas at startup.
// - Validate the input before any 402 [P8] and the handler's output before settling or storing it [S1].
// - The handler receives only the parsed input and an AbortSignal, never payment data.

export {};
