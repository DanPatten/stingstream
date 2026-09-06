import { describe, expect, test } from "bun:test";
import { formatUuidV4 } from "./uuid";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("formatUuidV4", () => {
  test("stamps the version and variant bits whatever the bytes were", () => {
    expect(formatUuidV4(new Uint8Array(16))).toMatch(UUID_V4);
    expect(formatUuidV4(new Uint8Array(16).fill(0xff))).toMatch(UUID_V4);
  });

  test("keeps every other byte", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i);
    // 0-5, 7, and 9-15 pass through untouched; 6 and 8 carry the version/variant bits.
    expect(formatUuidV4(bytes)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  test("different bytes give different ids", () => {
    const a = formatUuidV4(Uint8Array.from({ length: 16 }, (_, i) => i));
    const b = formatUuidV4(Uint8Array.from({ length: 16 }, (_, i) => 16 - i));
    expect(a).not.toBe(b);
  });

  test("too few bytes is a mistake worth hearing about", () => {
    expect(() => formatUuidV4(new Uint8Array(8))).toThrow();
  });
});
