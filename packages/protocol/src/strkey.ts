// Stellar address checks (strkey, SEP-23) for the addresses a manifest names: G... accounts and C...
// contracts. Dependency-free, so the read-only discovery server can use it; test/strkey.test.ts pins
// it to @stellar/stellar-sdk.

export type StellarAddressKind = "account" | "contract";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ADDRESS_LENGTH = 56; // 1 version byte + 32 bytes + 2 checksum bytes, base32 without padding
const VERSION_BYTES: ReadonlyMap<number, StellarAddressKind> = new Map([
  [6 << 3, "account"], // "G"
  [2 << 3, "contract"], // "C"
]);

/**
 * Returns "account" for a valid G... address, "contract" for a valid C... address and undefined for
 * anything else, including a wrong checksum. Muxed (M...) addresses and secret seeds are undefined.
 */
export function stellarAddressKind(address: string): StellarAddressKind | undefined {
  if (address.length !== ADDRESS_LENGTH) return undefined;
  const bytes = decodeBase32(address);
  if (bytes === undefined) return undefined;

  const checksum = crc16Xmodem(bytes.subarray(0, 33));
  // The checksum is stored little-endian.
  if (bytes[33] !== (checksum & 0xff) || bytes[34] !== checksum >> 8) return undefined;
  return VERSION_BYTES.get(bytes[0] ?? -1);
}

function decodeBase32(text: string): Uint8Array | undefined {
  const bytes = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return undefined;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  // 56 characters are exactly 35 bytes, so no bits may be left over.
  return bits === 0 ? bytes : undefined;
}

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
