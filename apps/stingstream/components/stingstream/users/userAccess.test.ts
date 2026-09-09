import { describe, expect, test } from "bun:test";
import type { UserPolicy } from "@jellyfin/sdk/lib/generated-client/models";
import type { PickableLibrary } from "../shared/LibraryPicker";
import {
  adminChangeBlocked,
  describeAccess,
  policyForAdminChange,
  policyForSelection,
  sameLibraryId,
  selectionForPolicy,
} from "./userAccess";

const MOVIES = "11111111-1111-1111-1111-111111111111";
const TV = "22222222-2222-2222-2222-222222222222";
const MUSIC = "33333333-3333-3333-3333-333333333333";

const available: PickableLibrary[] = [
  { id: MOVIES, name: "Movies" },
  { id: TV, name: "TV Shows" },
  { id: MUSIC, name: "Music" },
];

const policy = (over: Partial<UserPolicy> = {}): UserPolicy =>
  ({
    EnableAllFolders: false,
    EnabledFolders: [],
    ...over,
  }) as UserPolicy;

describe("sameLibraryId", () => {
  test("a dashed guid and a bare one are the same library", () => {
    // Jellyfin hands guids back in whichever shape the serialiser felt like, and comparing them as
    // plain strings would read an account with every library as one with none.
    expect(sameLibraryId(MOVIES, MOVIES.replace(/-/g, ""))).toBe(true);
    expect(sameLibraryId(MOVIES.toUpperCase(), MOVIES)).toBe(true);
    expect(sameLibraryId(MOVIES, TV)).toBe(false);
  });
});

describe("describeAccess", () => {
  test("EnableAllFolders is `all`, whatever else the policy names", () => {
    expect(
      describeAccess(
        policy({ EnableAllFolders: true, EnabledFolders: [MOVIES] }),
        available,
      ),
    ).toEqual({ kind: "all" });
  });

  test("nothing enabled is `none`", () => {
    expect(describeAccess(policy(), available)).toEqual({ kind: "none" });
    expect(describeAccess(null, available)).toEqual({ kind: "none" });
  });

  test("the libraries by name once the list has loaded", () => {
    expect(
      describeAccess(policy({ EnabledFolders: [TV, MOVIES] }), available),
    ).toEqual({ kind: "named", names: ["Movies", "TV Shows"] });
  });

  test("names survive a guid whose dashes the server dropped", () => {
    expect(
      describeAccess(
        policy({ EnabledFolders: [MOVIES.replace(/-/g, "")] }),
        available,
      ),
    ).toEqual({ kind: "named", names: ["Movies"] });
  });

  test("a count while the library list is still in flight", () => {
    expect(
      describeAccess(policy({ EnabledFolders: [MOVIES, TV] }), undefined),
    ).toEqual({ kind: "count", count: 2 });
  });

  test("a library this list has never heard of falls back to a count", () => {
    // Half a name list is worse than a number: it would silently drop a library the account really
    // can see.
    expect(
      describeAccess(
        policy({ EnabledFolders: [MOVIES, "unknown"] }),
        available,
      ),
    ).toEqual({ kind: "count", count: 2 });
  });
});

describe("selectionForPolicy", () => {
  test("everything ticked for an account that can see everything", () => {
    expect(
      selectionForPolicy(policy({ EnableAllFolders: true }), available),
    ).toEqual([MOVIES, TV, MUSIC]);
  });

  test("the picker gets the library list's own ids, not the policy's spelling", () => {
    expect(
      selectionForPolicy(
        policy({ EnabledFolders: [TV.replace(/-/g, "")] }),
        available,
      ),
    ).toEqual([TV]);
  });

  test("no access seeds an empty picker rather than a full one", () => {
    // `useChosenLibraries` ticks everything, which is right for a new invite and a lie here.
    expect(selectionForPolicy(policy(), available)).toEqual([]);
  });
});

describe("policyForSelection", () => {
  test("every box ticked becomes EnableAllFolders, not a pinned list", () => {
    // Somebody who ticks every box means "everything", including the library they add next month.
    expect(
      policyForSelection(policy(), [MOVIES, TV, MUSIC], available),
    ).toEqual(policy({ EnableAllFolders: true, EnabledFolders: [] }));
  });

  test("anything less is an explicit list", () => {
    expect(
      policyForSelection(
        policy({ EnableAllFolders: true }),
        [MOVIES, TV],
        available,
      ),
    ).toEqual(
      policy({ EnableAllFolders: false, EnabledFolders: [MOVIES, TV] }),
    );
  });

  test("nothing ticked takes every library away", () => {
    expect(
      policyForSelection(policy({ EnableAllFolders: true }), [], available),
    ).toEqual(policy({ EnableAllFolders: false, EnabledFolders: [] }));
  });

  test("an empty server cannot be mistaken for `everything`", () => {
    expect(policyForSelection(policy(), [], [])).toMatchObject({
      EnableAllFolders: false,
    });
  });

  test("the rest of the policy is carried through untouched", () => {
    // `updateUserPolicy` replaces the whole thing, so a permission dropped here is one revoked by
    // accident.
    const existing = policy({
      IsAdministrator: true,
      IsDisabled: true,
      EnableContentDeletion: true,
    });

    expect(policyForSelection(existing, [MOVIES], available)).toMatchObject({
      IsAdministrator: true,
      IsDisabled: true,
      EnableContentDeletion: true,
    });
  });
});

describe("adminChangeBlocked", () => {
  const account = (id: string, isAdministrator = false) => ({
    Id: id,
    Policy: policy({ IsAdministrator: isAdministrator }),
  });

  const me = { Id: "me" };

  test("promoting is never blocked", () => {
    // Handing somebody administration is a decision, not a hazard, and the only screen that can
    // make it is already administrator-only.
    const viewer = account("sam");
    expect(adminChangeBlocked(viewer, me, [account("me", true), viewer])).toBe(
      null,
    );
  });

  test("you cannot demote yourself", () => {
    // The server does not stop you, which is the problem: it is one tap, it is silent, and the
    // screen you would use to undo it is the one you just locked yourself out of.
    const self = account("me", true);
    expect(adminChangeBlocked(self, me, [self, account("dan", true)])).toBe(
      "self",
    );
  });

  test("you cannot demote the last administrator", () => {
    // Jellyfin's own last-administrator guard covers deletion, not demotion.
    const only = account("dan", true);
    expect(adminChangeBlocked(only, me, [only, account("sam")])).toBe(
      "last-administrator",
    );
  });

  test("demoting one of two administrators is allowed", () => {
    const other = account("dan", true);
    expect(adminChangeBlocked(other, me, [account("me", true), other])).toBe(
      null,
    );
  });

  test("a list that has not loaded reads as blocked, not as go-ahead", () => {
    // `< 2` rather than `=== 1`, so an empty or in-flight list can never be the thing that lets
    // the last administrator be demoted.
    const admin = account("dan", true);
    expect(adminChangeBlocked(admin, me, [])).toBe("last-administrator");
    expect(adminChangeBlocked(admin, me, null)).toBe("last-administrator");
    expect(adminChangeBlocked(admin, me, undefined)).toBe("last-administrator");
  });

  test("self wins over last-administrator when both apply", () => {
    // The sentence should name the thing the person can do something about.
    const self = account("me", true);
    expect(adminChangeBlocked(self, me, [self])).toBe("self");
  });
});

describe("policyForAdminChange", () => {
  test("promoting says everything rather than pinning today's list", () => {
    const before = policy({
      EnabledFolders: [MOVIES],
      EnableAllFolders: false,
    });
    expect(policyForAdminChange(before, true)).toMatchObject({
      IsAdministrator: true,
      EnableAllFolders: true,
      EnabledFolders: [],
    });
  });

  test("demoting leaves them able to see nothing until somebody picks", () => {
    // The sharp edge: an account that quietly kept every library after being demoted is the one
    // outcome this must not produce.
    const before = policy({ IsAdministrator: true, EnableAllFolders: true });
    expect(policyForAdminChange(before, false)).toMatchObject({
      IsAdministrator: false,
      EnableAllFolders: false,
      EnabledFolders: [],
    });
  });

  test("the rest of the policy is carried through untouched", () => {
    // `updateUserPolicy` replaces the whole thing, so a permission dropped here is one revoked by
    // accident -- the same reason `policyForSelection` spreads rather than rebuilds.
    const before = policy({
      IsDisabled: true,
      EnableContentDeletion: true,
      EnableRemoteControlOfOtherUsers: true,
    });
    expect(policyForAdminChange(before, true)).toMatchObject({
      IsDisabled: true,
      EnableContentDeletion: true,
      EnableRemoteControlOfOtherUsers: true,
    });
  });
});
