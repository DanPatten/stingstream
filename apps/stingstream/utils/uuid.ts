/**
 * Format 16 random bytes as a version-4 UUID.
 *
 * Its own module, with no imports: `utils/device.ts` reaches `react-native` through MMKV, and
 * `bun:test` cannot parse that — a pure rule with a test is worth more than one line saved.
 */
export const formatUuidV4 = (bytes: Uint8Array): string => {
  if (bytes.length < 16) throw new Error("a UUID needs 16 bytes");
  const b = Uint8Array.from(bytes.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};
