/**
 * Public or Private, and the one rule that decides which.
 *
 * Pure and outside the component for the same reason as `sharingAddress.ts`: this is where a screen
 * and a node would come to disagree about what a group is, and `bun:test` cannot reach anything
 * that imports `react-native`.
 */

export type GroupVisibility = "public" | "private";

/**
 * A group is Public exactly when it carries a coordinator.
 *
 * One function, used by the create screen, the group screen and any test, so there is no separate
 * flag to fall out of step with the record. The coordinator's presence **is** the visibility, which
 * is what makes a group read back from the node unable to contradict the radio that made it.
 */
export const visibilityOf = (
  coordinator: string | null | undefined,
): GroupVisibility => (coordinator?.trim() ? "public" : "private");

/**
 * The `coordinator` to send when creating a group or changing one.
 *
 * Public with no sharing server configured yields `null`, which would create a Private group — so
 * the screens must not offer Public in that state. They do not: `publicAvailable` disables the row,
 * and a failed settings query counts as "no server" rather than "not loaded yet" for exactly this
 * reason.
 */
export const coordinatorFor = (
  visibility: GroupVisibility,
  sharingServer: string | null,
): string | null => (visibility === "public" ? sharingServer : null);
