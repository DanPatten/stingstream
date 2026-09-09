import { describe, expect, test } from "bun:test";
import type { UserPolicy } from "@jellyfin/sdk/lib/generated-client/models";
import type { PickableLibrary } from "../shared/LibraryPicker";
import {
  describeAccess,
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
