// text-stats: 0.01 USDC, charge "on-success". Deterministic word, sentence and character counts.
// It finishes in well under a second, so create-job answers 200 with the output, and a handler
// failure is never charged.

import { defineService } from "@stellar-agent-services/provider-kit";

export const textStats = defineService({
  name: "text-stats",
  title: "Text statistics",
  description: "Counts the words, sentences and characters in a text.",
  price: "0.01",
  charge: "on-success",
  expectedDurationSeconds: 1,
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength: 10000, description: "The text to analyse" } },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["words", "sentences", "characters"],
    properties: {
      words: { type: "integer" },
      sentences: { type: "integer" },
      characters: { type: "integer" },
    },
  },
  examples: [{ input: { text: "Hello world." }, output: { words: 2, sentences: 1, characters: 12 } }],
  handler: ({ text }: { text: string }) => ({
    words: text.split(/\s+/).filter(Boolean).length,
    sentences: text.split(/[.!?]+/).filter((part) => part.trim() !== "").length,
    characters: text.length,
  }),
});
