// Durable JobStore on the built-in node:sqlite (Node >= 22.13, no native dependency).
//
// TODO:
// - Tables: jobs (job_id PK, service, binding_hash, token_hash, status, output, payment_receipt,
//   failure_code, timestamps) and payments (fingerprint UNIQUE, job_id, tx_hash, outcome).
// - Transitions as conditional UPDATEs (WHERE status = from).

export {};
