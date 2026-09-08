/**
 * The rules the Sharing server fields are judged by: what may be saved, and what gets stored.
 *
 * Split out of `components/stingstream/mesh/SharingAddress.tsx` for the reason `meshApi.ts` is
 * split out of `mesh.ts` — `bun:test` cannot load anything that reaches `react-native`, and these
 * are the two functions where a mistake is invisible. A screen that says one thing while the node
 * stores another is precisely the failure this whole rework exists to remove, and it is not the
 * kind of thing a screenshot catches.
 */

import type { CoordinatorCheck } from "./coordinator";

/** What a field will take. A coordinator and a node answer `/healthz` differently. */
export type SharingAddressAccept = "coordinator" | "own-server";

/** Prefilled into the sharing-server field, so the common case is "leave it alone". */
export const DEFAULT_SHARING_SERVER =
  "https://stingstream-coordinator-production.up.railway.app";

export type SharingAddressValue = {
  /** Exactly what is in the field, so the parent can round-trip it. */
  input: string;
  /** What the probe made of it; idle until it has answered. */
  check: CoordinatorCheck;
};

export const sharingAddress = (input = ""): SharingAddressValue => ({
  input,
  check: { state: "idle" },
});

export const isBlank = (value: SharingAddressValue) =>
  value.input.trim().length === 0;

/** The address we ship, untouched. Not a guess a typo could be hiding in. */
export const isShippedDefault = (value: SharingAddressValue) =>
  value.input.trim() === DEFAULT_SHARING_SERVER;

/**
 * Whether a field's value can be saved.
 *
 * Blank is always fine — clearing an address is an ordinary thing to do, and for the sharing server
 * it is how somebody says they want no server at all.
 *
 * The **shipped address counts as ready even when its check has not succeeded.** It is ours rather
 * than something typed, so there is no typo for the check to catch, and a coordinator having a
 * moment — or a browser that discarded the answer for want of a CORS header, which every
 * coordinator built before this session's fix does — must not stop somebody saving a setting. An
 * address that was *typed* and answered wrong still blocks, which is the case the check exists for.
 */
export const sharingAddressReady = (
  value: SharingAddressValue,
  accept: SharingAddressAccept,
): boolean => {
  if (isBlank(value)) return true;
  if (accept === "coordinator") {
    return value.check.state === "ok" || isShippedDefault(value);
  }
  return value.check.state === "own-server";
};

/** The URL to store, or `null` when there is nothing usable in the field. */
export const sharingAddressUrl = (
  value: SharingAddressValue,
  accept: SharingAddressAccept,
): string | null => {
  if (isBlank(value)) return null;
  if (accept === "coordinator") {
    if (value.check.state === "ok") return value.check.url;
    // The shipped address still counts when the check could not complete — see above. Without
    // this the field would show an address while the setting was quietly saved empty.
    if (isShippedDefault(value) && value.check.state !== "own-server") {
      return DEFAULT_SHARING_SERVER;
    }
    return null;
  }
  return value.check.state === "own-server" ? value.check.url : null;
};

/**
 * Whether a field still holds exactly what the node gave it.
 *
 * The check runs from *this browser*, which is not necessarily where the address resolves: an admin
 * on mobile data editing a domain that only answers at home would otherwise find an untouched field
 * marked wrong, `Save` disabled by a value they never typed, and — worse — a save that wrote `null`
 * over an address that was fine. An untouched value is passed straight back through.
 */
export const isUntouched = (
  value: SharingAddressValue,
  stored: string | null | undefined,
) => value.input.trim() === (stored ?? "").trim();
