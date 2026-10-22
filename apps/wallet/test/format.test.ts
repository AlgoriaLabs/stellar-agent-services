import { describe, expect, it } from "vitest";
import { formatAmount, humanize, parseAmount, shortAddress, timeAgo } from "../src/lib/format.js";

describe("amounts", () => {
  it("shows base units as decimals, with at least two places", () => {
    expect(formatAmount(100000n)).toBe("0.01");
    expect(formatAmount("50000000")).toBe("5.00");
    expect(formatAmount(1n)).toBe("0.0000001");
    expect(formatAmount(12_345_678_901n)).toBe("1,234.5678901");
    expect(formatAmount(99_999_999_999n, 2)).toBe("9,999.99");
  });

  it("reads decimals into base units, and nothing else", () => {
    expect(parseAmount("0.10")).toBe(1_000_000n);
    expect(parseAmount(" 5 ")).toBe(50_000_000n);
    expect(parseAmount("0.0000001")).toBe(1n);
    expect(parseAmount("0.00000001")).toBeUndefined();
    expect(parseAmount("-1")).toBeUndefined();
    expect(parseAmount("1e3")).toBeUndefined();
  });
});

describe("labels", () => {
  it("shortens addresses but keeps both ends", () => {
    expect(shortAddress("GDTC6FXXMBVQK6BWHETHO27KXFQHLUA27QJMOL4AZMVZJYWVPCY72JMH")).toBe("GDTC…2JMH");
  });

  it("turns schema keys into labels", () => {
    expect(humanize("text")).toBe("Text");
    expect(humanize("maxWords")).toBe("Max words");
    expect(humanize("max_words")).toBe("Max words");
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(timeAgo("2026-10-22T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-10-22T11:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-10-22T09:00:00Z", now)).toBe("3 h ago");
  });
});
