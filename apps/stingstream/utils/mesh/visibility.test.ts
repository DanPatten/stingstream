import { describe, expect, test } from "bun:test";
import { coordinatorFor, visibilityOf } from "./visibility";

describe("a group is Public exactly when it carries a coordinator", () => {
  test("a coordinator means Public", () => {
    expect(visibilityOf("https://coord.example.org")).toBe("public");
  });

  test("absent, null and empty all mean Private", () => {
    expect(visibilityOf(null)).toBe("private");
    expect(visibilityOf(undefined)).toBe("private");
    expect(visibilityOf("")).toBe("private");
    expect(visibilityOf("   ")).toBe("private");
  });

  /**
   * The property that keeps the radio honest: whatever the screen sends, reading the group back
   * gives the same answer. Without it a group could show as Public while the node held nothing,
   * which is the failure the whole rework exists to remove.
   */
  test("what is sent round-trips to what is shown", () => {
    const server = "https://coord.example.org";
    expect(visibilityOf(coordinatorFor("public", server))).toBe("public");
    expect(visibilityOf(coordinatorFor("private", server))).toBe("private");
  });
});

describe("what gets sent when a group is created or changed", () => {
  test("Public sends the sharing server, Private sends null", () => {
    expect(coordinatorFor("public", "https://coord.example.org")).toBe(
      "https://coord.example.org",
    );
    expect(coordinatorFor("private", "https://coord.example.org")).toBeNull();
    expect(coordinatorFor("private", null)).toBeNull();
  });

  /**
   * Public with no server configured yields null, which would create a *Private* group while the
   * screen said Public. That is why the screens disable the row when no server is known — including
   * when the settings query failed, which counts as "no server" rather than "not loaded yet". The
   * rule is pinned here so the reason for that disabling cannot be optimised away later.
   */
  test("Public with nothing configured would silently be Private", () => {
    expect(coordinatorFor("public", null)).toBeNull();
    expect(visibilityOf(coordinatorFor("public", null))).toBe("private");
  });
});
