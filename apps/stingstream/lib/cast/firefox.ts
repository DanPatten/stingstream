/**
 * Firefox has no Cast sender of its own, but the fx_cast extension injects the
 * same `chrome.cast` API Chrome ships, so the reader can cast without
 * switching browsers. The unsupported-browser dialog points there instead.
 */
export const FX_CAST_URL = "https://hensm.github.io/fx_cast/";

export const isFirefoxUserAgent = (userAgent: string): boolean =>
  /firefox\//i.test(userAgent);

export const isFirefox = (): boolean =>
  isFirefoxUserAgent(globalThis.navigator?.userAgent ?? "");
