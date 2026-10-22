// Amounts, addresses and times, written for people. Amounts are base units (7 decimals for USDC and XLM)
// everywhere else in the page; only this module turns them into decimals.

const DECIMALS = 7;
const SCALE = 10n ** BigInt(DECIMALS);

/** 100000n → "0.01". At least two decimals, at most `maxDecimals`, cut rather than rounded. */
export function formatAmount(baseUnits: string | bigint, maxDecimals = DECIMALS): string {
  const units = BigInt(baseUnits);
  const sign = units < 0n ? "-" : "";
  const magnitude = units < 0n ? -units : units;
  const whole = (magnitude / SCALE).toLocaleString("en-US");
  const fraction = (magnitude % SCALE).toString().padStart(DECIMALS, "0").slice(0, Math.max(2, maxDecimals)).replace(/0+$/, "");
  return `${sign}${whole}.${fraction.padEnd(2, "0")}`;
}

/** "0.01" → 100000n, or undefined when it is not an amount with at most seven decimals. */
export function parseAmount(text: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(text.trim());
  if (match === null) return undefined;
  return BigInt(match[1]! + (match[2] ?? "").padEnd(DECIMALS, "0"));
}

/** "GDTC…2JMH": enough to recognize an address, never enough to approve one. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 6)}…${hash.slice(-6)}` : hash;
}

/** "just now", "5 min ago", "3 h ago", then the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "about 40 s", "about 2 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} s`;
  return `about ${Math.round(seconds / 60)} min`;
}

/** "maxWords" or "max_words" → "Max words". */
export function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
