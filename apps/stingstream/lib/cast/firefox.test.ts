import { describe, expect, test } from "bun:test";
import { isFirefoxUserAgent } from "./firefox";

describe("isFirefoxUserAgent", () => {
  test("Firefox desktop is Firefox", () => {
    expect(
      isFirefoxUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
      ),
    ).toBe(true);
  });

  test("Chrome, Edge and Safari are not", () => {
    for (const ua of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    ]) {
      expect(isFirefoxUserAgent(ua)).toBe(false);
    }
  });

  test("an empty user agent is not", () => {
    expect(isFirefoxUserAgent("")).toBe(false);
  });
});
