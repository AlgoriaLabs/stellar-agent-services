// HTTP routes (Fetch API). Job paths are fixed relative to baseUrl (docs/provider-standard.md §5).
//
// TODO:
//   GET  <manifest path>                 -> manifest
//   POST {baseUrl}/services/{name}/jobs  -> create-job   (x402; Idempotency-Key + Job-Token, or neither)
//   GET  {baseUrl}/jobs/{jobId}          -> check-status (Job-Token)
//   GET  {baseUrl}/jobs/{jobId}/result   -> get-result   (Job-Token)
//
// - create-job follows the processing order in §5.4: headers and size, service, existing job,
//   input validation, capacity, 402, payment verification, atomic claim, then settle and run.
// - All three return a JobView: 200 when finished, 202 with Retry-After (and Location on create-job)
//   otherwise. create-job holds the response for at most 30 s [J9].
// - Same job id with a different binding or token: 422. Still being claimed or settled: 409.
//   Wrong token, unknown or expired job: 404, so the response does not reveal whether it exists.
// - Errors are RFC 9457 problem details. JSON only, body size caps, no redirects. Error bodies never
//   echo headers, payment payloads or tokens.

export {};
