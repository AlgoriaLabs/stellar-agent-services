// summarize: 0.01 USDC, charged only if it succeeds. Replace the handler with your own work, such as a model call,
// and keep the description, schemas and example in step with it: agents read them before they pay.

import { defineService } from "@stellar-agent-services/provider-kit";

type Input = { text: string; sentences?: number };

export const summarize = defineService({
  name: "summarize",
  title: "Summarize",
  description:
    "Returns the first sentences of an English text, with its sentence and word counts. Use it to shorten text before passing it on. Accepts up to 20,000 characters; it does not paraphrase.",
  price: "0.01",
  charge: "on-success",
  expectedDurationSeconds: 1,
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 20000, description: "The text to summarize" },
      sentences: { type: "integer", minimum: 1, maximum: 5, default: 1, description: "How many sentences to keep" },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["summary", "sentences", "words"],
    properties: {
      summary: { type: "string" },
      sentences: { type: "integer", description: "Sentences in the text" },
      words: { type: "integer", description: "Words in the text" },
    },
  },
  examples: [
    {
      input: { text: "Stellar settles in seconds. Fees are tiny.", sentences: 1 },
      output: { summary: "Stellar settles in seconds.", sentences: 2, words: 7 },
    },
  ],
  handler: ({ text, sentences = 1 }: Input) => {
    const parts = text
      .split(/(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    return { summary: parts.slice(0, sentences).join(" "), sentences: parts.length, words: text.split(/\s+/).filter(Boolean).length };
  },
});
