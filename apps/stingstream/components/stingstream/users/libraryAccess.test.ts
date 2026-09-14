import { describe, expect, test } from "bun:test";
import type { UserPolicy } from "@jellyfin/sdk/lib/generated-client/models";
import type { PickableLibrary } from "../shared/LibraryPicker";
import { hasLibrary, policyWithLibrary } from "./userAccess";

const MOVIES = "11111111111111111111111111111111";
const TV = "22222222222222222222222222222222";
const KIDS = "33333333333333333333333333333333";

const available: PickableLibrary[] = [
  { id: MOVIES, name: "Movies" },
  { id: TV, name: "TV Shows" },
  { id: KIDS, name: "Kids TV" },
];

const policy = (over: Partial<UserPolicy> = {}): UserPolicy =>
  ({
    EnableAllFolders: false,
    EnabledFolders: [],
    EnableContentDownloading: true,
    ...over,
  }) as UserPolicy;

describe("hasLibrary", () => {
  test("an administrator and an everything account see every library", () => {
    expect(hasLibrary(policy({ IsAdministrator: true }), KIDS)).toBe(true);
    expect(hasLibrary(policy({ EnableAllFolders: true }), KIDS)).toBe(true);
  });

  test("otherwise it is the list, whatever shape the ids come in", () => {
    const dashed = "11111111-1111-1111-1111-111111111111";
    expect(hasLibrary(policy({ EnabledFolders: [dashed] }), MOVIES)).toBe(true);
    expect(hasLibrary(policy({ EnabledFolders: [dashed] }), TV)).toBe(false);
  });
});

describe("policyWithLibrary", () => {
  test("granting adds the library and leaves the rest of the policy alone", () => {
    const next = policyWithLibrary(
      policy({ EnabledFolders: [MOVIES] }),
      TV,
      true,
      available,
    );
    expect(next.EnabledFolders).toEqual([MOVIES, TV]);
    expect(next.EnableAllFolders).toBe(false);
    expect(next.EnableContentDownloading).toBe(true);
  });

  test("granting the last missing library becomes everything", () => {
    const next = policyWithLibrary(
      policy({ EnabledFolders: [MOVIES, TV] }),
      KIDS,
      true,
      available,
    );
    expect(next.EnableAllFolders).toBe(true);
    expect(next.EnabledFolders).toEqual([]);
  });

  test("taking one from an everything account lists every other library", () => {
    const next = policyWithLibrary(
      policy({ EnableAllFolders: true }),
      KIDS,
      false,
      available,
    );
    expect(next.EnableAllFolders).toBe(false);
    expect(next.EnabledFolders).toEqual([MOVIES, TV]);
  });

  test("an id the picker does not know about survives a change to another library", () => {
    const unknown = "99999999999999999999999999999999";
    const next = policyWithLibrary(
      policy({ EnabledFolders: [unknown, MOVIES] }),
      MOVIES,
      false,
      available,
    );
    expect(next.EnabledFolders).toEqual([unknown]);
  });
});
