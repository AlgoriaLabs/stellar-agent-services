import { describe, it } from "vitest";

// Job Recovery: create-job, check-status, get-result (docs/job-recovery.md).
describe("job recovery", () => {
  it.todo("after a lost response, check-status and get-result return the stored result");
  it.todo("an async job moves queued -> running -> succeeded and its result is retrievable");
  it.todo("terminal states never transition again");
  it.todo("expired jobs are removed after retentionSeconds");
});
