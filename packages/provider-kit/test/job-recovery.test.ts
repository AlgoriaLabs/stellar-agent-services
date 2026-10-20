import { describe, it } from "vitest";

// Job Recovery: create-job, check-status, get-result (docs/provider-standard.md §5).
describe("job recovery", () => {
  it.todo("after a lost response, check-status and get-result return the stored result");
  it.todo("an upfront job answers 202, moves queued -> running -> succeeded, and its result is retrievable");
  it.todo("create-job answers 200 when the job finishes within the hold time");
  it.todo("terminal states never transition again");
  it.todo("expired jobs are removed after retentionSeconds");
});
