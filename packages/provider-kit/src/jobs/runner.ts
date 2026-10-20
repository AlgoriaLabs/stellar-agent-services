// Runs jobs.
//
// TODO:
// - charge "on-success": verify -> run handler -> validate output -> settle. A handler failure, an
//   invalid output or a payment that expires first means no settlement and no charge [S1, S2].
// - charge "upfront": verify -> settle -> enqueue -> run in the background.
// - The client flow is the same for both: the HTTP layer answers 200 if the job finished within the
//   hold time, otherwise 202, and the client follows check-status and get-result.
// - Persist every state change before responding, so a lost response is always recoverable.
// - Handler timeouts via AbortSignal; the result is validated against the service's outputSchema.

export {};
