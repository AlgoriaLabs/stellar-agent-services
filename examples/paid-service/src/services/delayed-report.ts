// delayed-report: 0.02 USDC, charge "upfront", with a configurable delay. Used for the Job Recovery
// demo: settle -> 202 -> the client loses the connection -> check-status and get-result return the
// result with no second payment.
//
// Also the capacity demo (docs/provider-standard.md §5.8): two reports at a time, and a new one waits
// at most four rounds. With the default 40 s delay, ten requests at once means two run, eight queue
// with their positions, and an eleventh gets 503 with Retry-After before it is asked to pay.

import { defineService } from "@stellar-agent-services/provider-kit";

const delaySeconds = Number(process.env["REPORT_DELAY_SECONDS"] ?? "40");

export const delayedReport = defineService({
  name: "delayed-report",
  title: "Delayed report",
  description: `Writes a short report on a topic. Takes about ${delaySeconds} seconds, so it answers 202 and is polled.`,
  price: "0.02",
  charge: "upfront",
  expectedDurationSeconds: delaySeconds,
  capacity: { concurrency: 2, maxQueueWaitSeconds: 4 * delaySeconds },
  inputSchema: {
    type: "object",
    required: ["topic"],
    properties: { topic: { type: "string", minLength: 1, maxLength: 200 } },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["topic", "report", "finishedAt"],
    properties: { topic: { type: "string" }, report: { type: "string" }, finishedAt: { type: "string" } },
  },
  handler: async ({ topic }: { topic: string }, { signal }) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delaySeconds * 1000);
      signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
    });
    return {
      topic,
      report: `A report on "${topic}", written after ${delaySeconds} seconds of careful thought.`,
      finishedAt: new Date().toISOString(),
    };
  },
});
