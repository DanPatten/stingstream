import type { BaseItemPerson } from "@jellyfin/sdk/lib/generated-client/models";

/**
 * What a cast tile shows, worked out away from the tile itself.
 *
 * The same split as `metadata.ts` next door, and for the same reason: importing
 * `CastRow.tsx` in a test pulls in React Native, expo-router and — three hops
 * down — a PNG that bun cannot parse. The rules about what a caption says are
 * the part worth testing, so they live where a test can reach them.
 */

/** Two letters from a name, for a cast member the server has no photo of. */
export const initialsOf = (name: string | null | undefined): string => {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
};

/**
 * The role as a caption: the part, not the paperwork.
 *
 * "(uncredited)" is a note about the credit rather than a description of the
 * part, and on a 112 px tile it is most of the line — so it goes, along with the
 * separator debris that dropping it leaves behind when `dedupePeople` has
 * already joined two roles with a comma.
 */
export const roleCaption = (role: string | null | undefined): string | null => {
  const cleaned = (role ?? "")
    .replace(/\(\s*uncredited\s*\)/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,(\s*,)+/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
};

/** Same person credited twice (actor and writer) is one tile with both roles. */
export const dedupePeople = (
  people: BaseItemPerson[] | null | undefined,
): BaseItemPerson[] => {
  const byId = new Map<string, BaseItemPerson>();
  for (const person of people ?? []) {
    if (!person.Id) continue;
    const existing = byId.get(person.Id);
    if (!existing) {
      byId.set(person.Id, { ...person });
      continue;
    }
    if (person.Role && existing.Role && !existing.Role.includes(person.Role)) {
      existing.Role = `${existing.Role}, ${person.Role}`;
    } else if (person.Role && !existing.Role) {
      existing.Role = person.Role;
    }
  }
  return [...byId.values()];
};
