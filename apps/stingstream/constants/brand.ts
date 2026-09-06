/**
 * The single source for StingStream's own name, tagline, repo URL and User-Agent string —
 * every place in the app that needs to say who it is reads from here instead of hardcoding a
 * literal, so a future rename (or the wordmark/asset work in WP-BRAND) touches one file.
 * See brand.test.ts and docs/CONTRIBUTING.md's rebrand guard.
 */
export const BRAND = {
  name: "StingStream",
  tagline: "Your media, on every screen.",
  url: "https://github.com/DanPatten/stingstream",
  userAgent: "StingStream (https://github.com/DanPatten/stingstream)",
} as const;
