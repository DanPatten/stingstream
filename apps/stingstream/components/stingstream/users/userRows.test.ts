import { describe, expect, test } from "bun:test";
import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import type { InviteSummary } from "@/lib/stingstream/invitesApi";
import { buildUserRows } from "./userRows";

const user = (id: string, name: string): UserDto => ({ Id: id, Name: name });

const invite = (
  id: string,
  status: InviteSummary["status"],
  label = "",
): InviteSummary => ({
  id,
  label,
  libraries: [{ id: "lib", name: "Movies" }],
  createdByName: "dan",
  createdAt: "2026-09-09T00:00:00Z",
  expiresAt: null,
  status,
});

describe("buildUserRows", () => {
  test("accounts come first, in server order, then the pending invitations", () => {
    const rows = buildUserRows(
      [user("a", "sarah"), user("b", "tom")],
      [invite("i1", "valid", "jo")],
      "a",
    );

    expect(rows.map((row) => row.key)).toEqual([
      "user:a",
      "user:b",
      "invite:i1",
    ]);
  });

  test("the signed-in owner is listed, and marked", () => {
    // Sharing filtered them out, because it answered "who can see my things". This screen answers
    // "what accounts exist", and leaving the owner off it made the list a lie.
    const rows = buildUserRows([user("a", "dan"), user("b", "tom")], [], "a");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "account", isSelf: true });
    expect(rows[1]).toMatchObject({ kind: "account", isSelf: false });
  });

  test("nobody is `self` when there is no signed-in user yet", () => {
    const rows = buildUserRows([user("a", "dan")], [], undefined);
    expect(rows[0]).toMatchObject({ isSelf: false });
  });

  test("only invitations nobody has opened", () => {
    // A spent invitation describes an account that is already in the list above it, so showing
    // both would count the same person twice.
    const rows = buildUserRows(
      [],
      [
        invite("i1", "valid"),
        invite("i2", "used"),
        invite("i3", "expired"),
        invite("i4", "revoked"),
      ],
      "a",
    );

    expect(rows.map((row) => row.key)).toEqual(["invite:i1"]);
  });

  test("an account with no id is dropped rather than keyed on `undefined`", () => {
    const rows = buildUserRows(
      [{ Name: "ghost" }, user("a", "sarah")],
      [],
      "a",
    );
    expect(rows.map((row) => row.key)).toEqual(["user:a"]);
  });

  test("nothing loaded yet is an empty list, not a crash", () => {
    expect(buildUserRows(undefined, undefined, undefined)).toEqual([]);
    expect(buildUserRows(null, null, null)).toEqual([]);
  });
});
