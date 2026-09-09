import type { UserPolicy } from "@jellyfin/sdk/lib/generated-client/models";
import type { PickableLibrary } from "../shared/LibraryPicker";

/**
 * What an account can watch, and how to change it.
 *
 * Both halves are pure and live here rather than in the screen, because both are
 * rules rather than rendering: which libraries a policy names, and what a policy
 * should become when somebody ticks boxes. `userAccess.test.ts` pins them.
 *
 * The storage is Jellyfin's `UserPolicy` — `EnableAllFolders` plus
 * `EnabledFolders` — and there is no StingStream table for it. Nothing else in
 * the app has written folder access before now; the invite service does it once,
 * at accept time, and its own comment says removing access afterwards is "a
 * separate decision made on the Users screen".
 */

/**
 * Jellyfin hands GUIDs back in whichever shape the serialiser felt like.
 *
 * `Policy.EnabledFolders` and `GET /invites/libraries` both carry the same
 * library ids, and comparing them as plain strings is a bug waiting for the one
 * server that dashes one and not the other — a user would silently read as
 * having no libraries at all.
 */
export const sameLibraryId = (a: string, b: string): boolean =>
  a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();

export type AccessSummary =
  /** Everything, including libraries added later. */
  | { kind: "all" }
  | { kind: "none" }
  /** The libraries by name, once the library list has loaded. */
  | { kind: "named"; names: string[] }
  /** The same thing before it has: a count is honest, a guessed name is not. */
  | { kind: "count"; count: number };

export function describeAccess(
  policy: UserPolicy | null | undefined,
  libraries: PickableLibrary[] | null | undefined,
): AccessSummary {
  if (policy?.EnableAllFolders) return { kind: "all" };

  const enabled = policy?.EnabledFolders ?? [];
  if (enabled.length === 0) return { kind: "none" };

  const names = (libraries ?? [])
    .filter((library) => enabled.some((id) => sameLibraryId(id, library.id)))
    .map((library) => library.name);

  // A name for every id, or none of them. A partial list would quietly drop a
  // library the account really can see, which is worse than a count.
  return names.length === enabled.length
    ? { kind: "named", names }
    : { kind: "count", count: enabled.length };
}

/** Which of `available` this account can see, as the picker wants them: its own ids. */
export function selectionForPolicy(
  policy: UserPolicy | null | undefined,
  available: PickableLibrary[],
): string[] {
  if (policy?.EnableAllFolders) return available.map((library) => library.id);
  const enabled = policy?.EnabledFolders ?? [];
  return available
    .filter((library) => enabled.some((id) => sameLibraryId(id, library.id)))
    .map((library) => library.id);
}

/**
 * The policy to save for a set of ticked boxes.
 *
 * Everything ticked becomes `EnableAllFolders`, not a list of every id. Somebody
 * who ticks every box means "everything", and a pinned list would quietly
 * exclude the next library they add — while the row would go on reading "Every
 * library" until they noticed.
 *
 * The invite path does the opposite on purpose (`ApplyLibraryScopeAsync` always
 * writes an explicit list): an invite names a fixed set at a fixed moment, and
 * an invite that silently widened later would be a different promise from the
 * one somebody accepted.
 *
 * The rest of the policy is carried through untouched — `updateUserPolicy`
 * replaces the whole thing, so anything dropped here is a permission revoked by
 * accident.
 */
export function policyForSelection(
  policy: UserPolicy,
  selected: string[],
  available: PickableLibrary[],
): UserPolicy {
  const everything =
    available.length > 0 &&
    available.every((library) =>
      selected.some((id) => sameLibraryId(id, library.id)),
    );

  return everything
    ? { ...policy, EnableAllFolders: true, EnabledFolders: [] }
    : { ...policy, EnableAllFolders: false, EnabledFolders: selected };
}
