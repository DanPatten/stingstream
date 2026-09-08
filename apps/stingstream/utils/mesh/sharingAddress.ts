/**
 * The rules the Sharing address field is judged by: what may be saved, and what gets stored.
 *
 * Split out of `components/stingstream/mesh/SharingAddress.tsx` for the reason `meshApi.ts` is
 * split out of `mesh.ts` — `bun:test` cannot load anything that reaches `react-native`, and these
 * are the functions where a mistake is invisible. A screen that says one thing while the node
 * stores another is precisely the failure this rework exists to remove, and it is not the kind of
 * thing a screenshot catches.
 *
 * **There is no live probe any more.** The field used to ask the address itself what it was, so it
 * could tell a coordinator from your own server. With the coordinator gone there is only one kind
 * of address, and the probe never worked well for it anyway: an admin editing their home domain
 * from mobile data cannot resolve it from where they are standing. So this validates the *shape*,
 * which is what actually catches mistakes, and the node validates the rest on save — it is the one
 * that has to build links from it.
 */

export type SharingAddressValue = {
  /** Exactly what is in the field, so the parent can round-trip it. */
  input: string;
};

export const sharingAddress = (input = ""): SharingAddressValue => ({ input });

export const isBlank = (value: SharingAddressValue) =>
  value.input.trim().length === 0;

/**
 * Why an address cannot be used, or `null` when it can.
 *
 * These are the node's own rules (`stingstream_mesh::sharing::normalize_public_address`), checked
 * here too so somebody is told at the keyboard rather than after pressing Save. Each one produces a
 * link that looks right and does not work:
 *
 * - **A bare IP address.** A residential address rotates, so a minted link goes stale; no public
 *   certificate authority will issue for one; and behind carrier-grade NAT there is no inbound
 *   address at all.
 * - **Plain `http`.** The thing it opens is a browser app, and outside a secure context
 *   `crypto.randomUUID` and secure storage are simply absent — the exact crash this fork already
 *   hit once on LAN origins.
 * - **A single-label host.** Nothing outside the local network can resolve `nas`, so the link only
 *   works for people who did not need it.
 */
export const sharingAddressProblem = (
  value: SharingAddressValue,
): "not-a-url" | "insecure" | "ip-address" | "single-label" | null => {
  const raw = value.input.trim();
  if (!raw) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return "not-a-url";
  }
  if (url.protocol !== "https:") return "insecure";

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":"))
    return "ip-address";
  if (!host.includes(".")) return "single-label";
  return null;
};

/** Whether the field can be saved. Blank is always fine — clearing an address is ordinary. */
export const sharingAddressReady = (value: SharingAddressValue): boolean =>
  sharingAddressProblem(value) === null;

/** The origin to store, or `null` when there is nothing usable in the field. */
export const sharingAddressUrl = (
  value: SharingAddressValue,
): string | null => {
  const raw = value.input.trim();
  if (!raw || sharingAddressProblem(value)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  const url = new URL(withScheme);
  // An origin, not a URL: everything appended is an absolute path, and a trailing slash would show
  // up in the middle of a link as `https://host//join`.
  return `${url.protocol}//${url.host}`;
};

/**
 * Whether a field still holds exactly what the node gave it.
 *
 * An untouched value is passed straight back through rather than re-derived, so a stored address
 * the node normalised differently from this function is never silently rewritten by opening the
 * screen.
 */
export const isUntouched = (
  value: SharingAddressValue,
  stored: string | null | undefined,
) => value.input.trim() === (stored ?? "").trim();
