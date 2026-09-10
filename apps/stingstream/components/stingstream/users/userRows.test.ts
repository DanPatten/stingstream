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
  isAdministrator: false,
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

describe("the owner", () => {
  const account = (id: string, name: string) => ({ Id: id, Name: name });

  test("is marked, and only on that row", () => {
    const rows = buildUserRows(
      [account("owner-id", "dan"), account("other-id", "sam")],
      [],
      "other-id",
      "owner-id",
    );
    expect(rows.map((r) => (r.kind === "account" ? r.isOwner : null))).toEqual([
      true,
      false,
    ]);
  });

  test("is recognised whichever way the id is spelled", () => {
    // The owner comes from StingStream's own route and the row from `GET /Users`; Jellyfin hands
    // GUIDs back in whichever shape the serialiser felt like, so a plain string compare is a bug
    // waiting for the one server that dashes one and not the other.
    const rows = buildUserRows(
      [account("A4D809DC-5B3B-4072-9937-B55B8622BF85", "dan")],
      [],
      null,
      "a4d809dc5b3b40729937b55b8622bf85",
    );
    expect(rows[0].kind === "account" && rows[0].isOwner).toBe(true);
  });

  test("nobody is the owner when the server did not say", () => {
    // An older node, or a lookup that failed. A badge that fails to appear is a smaller mistake
    // than one that appears on the wrong person.
    for (const ownerId of [undefined, null, ""]) {
      const rows = buildUserRows([account("a", "dan")], [], null, ownerId);
      expect(rows[0].kind === "account" && rows[0].isOwner).toBe(false);
    }
  });

  test("owning and being yourself are independent", () => {
    const rows = buildUserRows([account("me", "dan")], [], "me", "me");
    expect(rows[0].kind === "account" && rows[0].isSelf).toBe(true);
    expect(rows[0].kind === "account" && rows[0].isOwner).toBe(true);
  });
});
