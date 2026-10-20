// Runs jobs.
//
// TODO:
// - sync + "after-work" (default): verify -> run handler -> settle. A handler failure means no
//   settlement and no charge.
// - async + "before-work" (default): verify -> settle -> enqueue -> run in the background. The client
//   follows check-status and get-result.
// - Persist every state change before responding, so a lost response is always recoverable.
// - Handler timeouts via AbortSignal; the result is validated against the service's output schema.

export {};
