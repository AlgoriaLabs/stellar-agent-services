// HTTP routes (Fetch API).
//
// TODO:
//   GET  <manifest path>              -> manifest
//   POST /services/{serviceId}/jobs   -> create-job  (x402-protected; Idempotency-Key + X-Job-Token)
//   GET  /jobs/{jobId}                -> check-status (X-Job-Token)
//   GET  /jobs/{jobId}/result         -> get-result   (X-Job-Token)
//
// Rules: JSON only, body size caps, no redirects. A wrong token returns 404 (the response does not
// reveal whether the job exists). The same job id with a different binding returns 409.
// Error bodies never echo headers or payment payloads.

export {};
