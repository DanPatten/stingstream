import { describe, expect, test } from "bun:test";
import {
  buildInviteLink,
  inviteCodeFromLocation,
  parseInviteInput,
} from "./inviteLink";

describe("buildInviteLink", () => {
  test("puts the code in the fragment, where no server will log it", () => {
    const link = buildInviteLink("https://media.example.com", "7KxQm2");
    expect(link).toBe("https://media.example.com/join#7KxQm2");
    const [path, fragment] = (link ?? "").split("#");
    expect(path).toBe("https://media.example.com/join");
    expect(fragment).toBe("7KxQm2");
  });

  test("never doubles the slash, whatever the host arrived as", () => {
    expect(buildInviteLink("https://media.example.com/", "7KxQm2")).toBe(
      "https://media.example.com/join#7KxQm2",
    );
    expect(buildInviteLink("  https://media.example.com//  ", "7KxQm2")).toBe(
      "https://media.example.com/join#7KxQm2",
    );
  });

  test("no host is a real answer, not an error", () => {
    expect(buildInviteLink(null, "7KxQm2")).toBeNull();
    expect(buildInviteLink(undefined, "7KxQm2")).toBeNull();
    expect(buildInviteLink("", "7KxQm2")).toBeNull();
    expect(buildInviteLink("https://media.example.com", "  ")).toBeNull();
  });
});

describe("parseInviteInput", () => {
  test("takes the code out of a link and ignores the host it came from", () => {
    expect(parseInviteInput("https://media.example.com/join#7KxQm2")).toBe(
      "7KxQm2",
    );
    expect(parseInviteInput("https://media.example.com/join#7KxQm2")).toBe(
      "7KxQm2",
    );
    expect(parseInviteInput("stingstream://join#7KxQm2")).toBe("7KxQm2");
    expect(parseInviteInput("  https://media.example.com/join#7KxQm2  ")).toBe(
      "7KxQm2",
    );
  });

  test("a bare code still works, because that is what older invites are", () => {
    expect(parseInviteInput("7KxQm2")).toBe("7KxQm2");
    expect(parseInviteInput("  7KxQm2  ")).toBe("7KxQm2");
  });

  /**
   * The case worth being strict about. A chat client that strips the fragment, or somebody copying
   * the address bar of a page that already consumed it, leaves a URL that looks entirely fine. Sent
   * on as a code it fails at the node as "not valid base58check", which names the symptom and hides
   * the cause.
   */
  test("a link whose fragment has been stripped is refused, not guessed at", () => {
    expect(parseInviteInput("https://media.example.com/join")).toBeNull();
    expect(parseInviteInput("https://media.example.com/join#")).toBeNull();
    expect(parseInviteInput("https://media.example.com/join#   ")).toBeNull();
  });

  test("something that is neither is refused", () => {
    expect(parseInviteInput("")).toBeNull();
    expect(parseInviteInput("   ")).toBeNull();
    expect(parseInviteInput("7KxQm2 with words after it")).toBeNull();
    expect(parseInviteInput("media.example.com/join")).toBeNull();
  });
});

describe("inviteCodeFromLocation", () => {
  const withHash = (hash: string, run: () => void) => {
    const original = globalThis.window;
    // @ts-expect-error — a minimal stand-in for the one property this reads.
    globalThis.window = { location: { hash } };
    try {
      run();
    } finally {
      if (original === undefined) {
        // @ts-expect-error — put the environment back exactly as it was found.
        delete globalThis.window;
      } else {
        globalThis.window = original;
      }
    }
  };

  test("reads the fragment of the page being viewed", () => {
    withHash("#7KxQm2", () => expect(inviteCodeFromLocation()).toBe("7KxQm2"));
  });

  test("percent-encoding survives the round trip", () => {
    withHash("#7Kx%2BQm2", () =>
      expect(inviteCodeFromLocation()).toBe("7Kx+Qm2"),
    );
  });

  test("no fragment, and no window at all, are both just null", () => {
    withHash("", () => expect(inviteCodeFromLocation()).toBeNull());
    withHash("#", () => expect(inviteCodeFromLocation()).toBeNull());
    expect(inviteCodeFromLocation()).toBeNull();
  });
});
