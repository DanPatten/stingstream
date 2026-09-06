import { describe, expect, test } from "bun:test";
import { redactUrl } from "./redactUrl";

/**
 * The credential this exists for is the caller's own Jellyfin access token, which rides in the
 * query string of every direct-play URL because that is how Jellyfin authenticates a player that
 * cannot set headers — and which was being printed to logcat and to the browser console verbatim.
 */
describe("redactUrl", () => {
  test("takes the ApiKey out of a direct-play URL and leaves everything else", () => {
    const url =
      "https://jf.example.com/Videos/abc/stream?static=true&container=mkv" +
      "&mediaSourceId=m1&ApiKey=aVeryRealSessionToken&userId=u1";
    const out = redactUrl(url);
    expect(out).not.toContain("aVeryRealSessionToken");
    // The parameter stays, because "it had an ApiKey" is what a person debugging needs to see.
    expect(out).toContain("ApiKey=%3Credacted%3E");
    expect(out).toContain("mediaSourceId=m1");
    expect(out).toContain("userId=u1");
    expect(out.startsWith("https://jf.example.com/Videos/abc/stream?")).toBe(true);
  });

  test("catches every spelling Jellyfin uses", () => {
    for (const key of [
      "ApiKey",
      "apikey",
      "api_key",
      "X-Emby-Token",
      "x-mediabrowser-token",
      "accessToken",
      "access_token",
      "token",
    ]) {
      expect(redactUrl(`https://x/y?${key}=SECRET`)).not.toContain("SECRET");
    }
  });

  test("a token containing URL-ish characters is still removed whole", () => {
    // A base64url token can carry `-`, `_` and `=`; a naive `[^&]*` regex gets this right by luck
    // rather than by rule, which is why this goes through URLSearchParams.
    const url = "https://x/y?ApiKey=ab-cd_ef%3D%3D&next=1";
    const out = redactUrl(url);
    expect(out).not.toContain("ab-cd_ef");
    expect(out).toContain("next=1");
  });

  test("leaves alone anything with no credential in it", () => {
    const plain = "https://x/y?static=true&container=mkv";
    expect(redactUrl(plain)).toBe(plain);
    const noQuery = "https://stingstream.local/stream/g/movie:tmdb:1/n";
    expect(redactUrl(noQuery)).toBe(noQuery);
  });

  test("never throws on something that is not a URL", () => {
    // These are log lines. One that threw would be a worse bug than the one being prevented.
    expect(redactUrl(null)).toBe("");
    expect(redactUrl(undefined)).toBe("");
    expect(redactUrl("")).toBe("");
    expect(redactUrl("not a url at all")).toBe("not a url at all");
    expect(redactUrl("?ApiKey=SECRET")).not.toContain("SECRET");
  });
});
