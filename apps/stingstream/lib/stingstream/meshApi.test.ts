import { describe, expect, test } from "bun:test";
import {
  ageOf,
  canManageMembers,
  canRemoveMember,
  confirmedAction,
  type MeshMember,
  type MeshNodePeer,
  memberRoster,
  toMembers,
  toRotation,
} from "./meshApi";

/**
 * The member-management half of the Group screen: the casing it has to survive, the roster it
 * builds out of two endpoints, and the two gates in front of an irreversible action.
 *
 * Core answers PascalCase (`docs/APP-MESH.md` §6) despite every doc calling these fields by their
 * camelCase names — the bug that made M3c's auto-membership quietly join nothing — so the first
 * tests here are what stop these decoders regressing to one casing.
 */
describe("toMembers", () => {
  const pascal = {
    Members: [
      {
        Node: "aaaa1111",
        NodeName: "attic",
        Online: true,
        LastSeen: "2026-09-05T09:00:00Z",
        IsSelf: true,
        Revoked: false,
      },
      {
        Node: "bbbb2222",
        NodeName: "loft",
        Online: false,
        LastSeen: "2026-09-03T09:00:00Z",
        IsSelf: false,
        Revoked: true,
      },
    ],
    Epoch: 3,
    RotatedAt: 1_788_000_000_000,
    RotatedBy: "aaaa1111",
  };

  const camel = {
    members: [
      {
        node: "aaaa1111",
        nodeName: "attic",
        online: true,
        lastSeen: "2026-09-05T09:00:00Z",
        isSelf: true,
        revoked: false,
      },
      {
        node: "bbbb2222",
        nodeName: "loft",
        online: false,
        lastSeen: "2026-09-03T09:00:00Z",
        isSelf: false,
        revoked: true,
      },
    ],
    epoch: 3,
    rotatedAt: 1_788_000_000_000,
    rotatedBy: "aaaa1111",
  };

  test("reads PascalCase, which is what Core actually answers", () => {
    const members = toMembers(pascal);
    expect(members.epoch).toBe(3);
    expect(members.rotatedAt).toBe(1_788_000_000_000);
    expect(members.rotatedBy).toBe("aaaa1111");
    expect(members.members).toHaveLength(2);
    expect(members.members[0]?.isSelf).toBe(true);
    expect(members.members[1]?.revoked).toBe(true);
    expect(members.members[1]?.online).toBe(false);
  });

  test("reads camelCase identically, so a naming-policy change needs no client change", () => {
    expect(toMembers(camel)).toEqual(toMembers(pascal));
  });

  test("survives a body with nothing in it", () => {
    expect(toMembers({})).toEqual({
      members: [],
      epoch: 0,
      rotatedAt: 0,
      rotatedBy: "",
    });
  });

  test("a member that has not said what it is called keeps an empty name", () => {
    // The screen falls back to a short node id; a decoder inventing one would hide the gap.
    const [only] = toMembers({ Members: [{ Node: "cccc3333" }] }).members;
    expect(only?.nodeName).toBe("");
    expect(only?.online).toBe(false);
    expect(only?.revoked).toBe(false);
  });
});

describe("toRotation", () => {
  test("reads both casings, and treats an absent 'removed' as a plain rotation", () => {
    const removal = toRotation({
      Group: "gggg",
      Epoch: 4,
      Removed: "bbbb2222",
      Reached: ["aaaa1111", "cccc3333"],
    });
    expect(removal.removed).toBe("bbbb2222");
    expect(removal.reached).toHaveLength(2);

    const rotation = toRotation({ group: "gggg", epoch: 4, reached: [] });
    expect(rotation.removed).toBeUndefined();
    expect(rotation.epoch).toBe(4);
    // Nobody awake is not a failure: the rest take the secret on their next dial.
    expect(rotation.reached).toEqual([]);
  });
});

describe("canManageMembers", () => {
  test("only an administrator, and never on a television", () => {
    expect(canManageMembers(true, false)).toBe(true);
    expect(canManageMembers(false, false)).toBe(false);
    expect(canManageMembers(true, true)).toBe(false);
    expect(canManageMembers(false, true)).toBe(false);
  });
});

describe("canRemoveMember", () => {
  const member = (over: Partial<MeshMember> = {}): MeshMember => ({
    node: "bbbb2222",
    nodeName: "loft",
    online: true,
    isSelf: false,
    revoked: false,
    ...over,
  });

  test("an ordinary member of a manageable group can be removed", () => {
    expect(canRemoveMember(member(), true)).toBe(true);
  });

  test("never when the group cannot be managed", () => {
    expect(canRemoveMember(member(), false)).toBe(false);
  });

  test("never this node — a node leaves a group, it does not remove itself", () => {
    expect(canRemoveMember(member({ isSelf: true }), true)).toBe(false);
  });

  test("never one already removed, which would rotate the secret again for nothing", () => {
    expect(canRemoveMember(member({ revoked: true }), true)).toBe(false);
  });

  test("never a row that is not there", () => {
    expect(canRemoveMember(undefined, true)).toBe(false);
    expect(canRemoveMember(null, true)).toBe(false);
  });
});

describe("memberRoster", () => {
  const peer = (over: Partial<MeshNodePeer> = {}): MeshNodePeer => ({
    group: "gggg",
    node: "bbbb2222",
    nodeName: "loft",
    online: true,
    firstSeen: "2026-09-01T00:00:00Z",
    path: "direct",
    rttMs: 12,
    ...over,
  });

  test("joins the link detail onto the roster, matching node ids case-insensitively", () => {
    const rows = memberRoster(
      [
        {
          node: "BBBB2222",
          nodeName: "loft",
          online: true,
          isSelf: false,
          revoked: false,
        },
      ],
      [peer({ node: "bbbb2222" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe("direct");
    expect(rows[0]?.rttMs).toBe(12);
  });

  test("falls back to the peer list alone, with nothing marked self or removed", () => {
    // What a non-administrator and a television see: the elevated roster was never fetched, and
    // the screen must not invent the two facts only that roster knows.
    const rows = memberRoster(undefined, [peer()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isSelf).toBe(false);
    expect(rows[0]?.revoked).toBe(false);
    expect(rows[0]?.path).toBe("direct");
  });

  test("removed members sink to the bottom rather than disappearing", () => {
    const rows = memberRoster(
      [
        {
          node: "1",
          nodeName: "gone",
          online: false,
          isSelf: false,
          revoked: true,
        },
        {
          node: "2",
          nodeName: "asleep",
          online: false,
          isSelf: false,
          revoked: false,
        },
        {
          node: "3",
          nodeName: "attic",
          online: true,
          isSelf: true,
          revoked: false,
        },
      ],
      [],
    );
    expect(rows.map((r) => r.nodeName)).toEqual(["attic", "asleep", "gone"]);
  });
});

describe("ageOf", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");

  test("reads an ISO last-seen and milliseconds-since-the-epoch alike", () => {
    expect(ageOf("2026-09-05T11:30:00Z", now)?.token).toBe("30m");
    expect(ageOf(Date.parse("2026-09-03T12:00:00Z"), now)?.token).toBe("2d");
  });

  test("gives up on a token past a week, leaving an absolute date to the caller", () => {
    const age = ageOf("2026-08-01T12:00:00Z", now);
    expect(age?.token).toBeNull();
    expect(age?.at).toBe(Date.parse("2026-08-01T12:00:00Z"));
  });

  test("nothing at all is null, including the 'never rotated' zero", () => {
    expect(ageOf(0, now)).toBeNull();
    expect(ageOf(null, now)).toBeNull();
    expect(ageOf(undefined, now)).toBeNull();
    expect(ageOf("", now)).toBeNull();
    expect(ageOf("not a date", now)).toBeNull();
  });

  test("a rotation stamped by a node whose clock runs fast is not in the future", () => {
    // `rotatedAt` comes from the rotating node's clock, so a few seconds of skew is ordinary.
    expect(ageOf(now + 5_000, now)?.token).toBe("1m");
  });
});

describe("confirmedAction", () => {
  test("does not act, and does not even ask, when the action is not allowed", async () => {
    let asked = false;
    let acted = false;
    const result = await confirmedAction({
      allowed: false,
      confirm: async () => {
        asked = true;
        return true;
      },
      act: async () => {
        acted = true;
        return "done";
      },
    });
    expect(result).toBeNull();
    expect(asked).toBe(false);
    expect(acted).toBe(false);
  });

  test("does not act when the confirmation is declined", async () => {
    let acted = false;
    const result = await confirmedAction({
      allowed: true,
      confirm: async () => false,
      act: async () => {
        acted = true;
        return "done";
      },
    });
    expect(result).toBeNull();
    expect(acted).toBe(false);
  });

  test("acts once, and hands back what the node said, when both gates pass", async () => {
    let calls = 0;
    const result = await confirmedAction({
      allowed: true,
      confirm: async () => true,
      act: async () => {
        calls += 1;
        return toRotation({ Group: "gggg", Epoch: 5, Reached: ["aaaa1111"] });
      },
    });
    expect(calls).toBe(1);
    expect(result?.epoch).toBe(5);
    expect(result?.reached).toEqual(["aaaa1111"]);
  });
});
