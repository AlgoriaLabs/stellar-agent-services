// In-memory JobStore for tests and local development. It is not durable, and the manifest must not
// advertise recovery beyond the process lifetime when this store is used.
//
// TODO: implement JobStore with the same atomicity guarantees as the SQLite store.

export {};
