// Addresses and times, written for people.

/** "GDTC…2JMH": enough to recognize an address, never enough to approve one. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Milliseconds left as "4:05". */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "Stellar Testnet" → "Testnet". */
export function shortNetwork(name: string): string {
  return name.replace(/^Stellar /, "");
}
