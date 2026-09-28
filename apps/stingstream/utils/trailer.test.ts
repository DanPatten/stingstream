import { describe, expect, test } from "bun:test";
import { trailerEmbedUrl } from "./trailer";

describe("embedded trailers", () => {
  test("accepts the provider's watch, short and embed URLs", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=aqz-KE-bpKQ&feature=share",
      "https://youtu.be/aqz-KE-bpKQ",
      "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ",
    ]) {
      expect(trailerEmbedUrl(url)).toBe(
        "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?autoplay=1&playsinline=1&rel=0",
      );
    }
  });
  test("does not embed unknown hosts or non-video URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      "https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ",
      "https://www.youtube.com/watch?v=invalid",
      "not a URL",
    ]) {
      expect(trailerEmbedUrl(url)).toBeNull();
    }
  });
});
