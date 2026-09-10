import { authHeaders } from "./meshApi";

/**
 * Who owns this server.
 *
 * The account that claimed it at first run. Dan: *"cannot be changed and is the first admin setup,
 * no transfer support and they are always an admin"* — so there is one call here and it only
 * reads. There is deliberately no setter to import, not even an administrator's.
 *
 * A plain `fetch` rather than the generated client, for the reason `identityApi.ts` gives: this
 * answers before a screen has decided anything, and the node's origin is not the Jellyfin base
 * path the generated client is keyed on.
 */

// Capitalised because that is the route the server advertises: `UsersController` takes its path
// from `[controller]`, unlike the hand-declared lowercase ones beside it. Routing is
// case-insensitive, so either works — matching the spec is for whoever reads both.
const OWNER_PATH = "/stingstream/api/v1/Users/owner";

/** How long the call gets before it is called unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The owner's user id, or null.
 *
 * Null on anything that is not a plain answer — an older node with no such route, a server that
 * somehow has no accounts, a request that failed. Every caller treats null as "mark nobody", which
 * is the right way to be wrong: a badge that fails to appear is a smaller mistake than one that
 * appears on the wrong person.
 */
export async function fetchServerOwner(
  nodeOrigin: string,
  accessToken: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `${nodeOrigin.replace(/\/+$/, "")}${OWNER_PATH}`,
      {
        method: "GET",
        headers: { accept: "application/json", ...authHeaders(accessToken) },
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const id = typeof body?.UserId === "string" ? body.UserId.trim() : "";
    return id.length > 0 ? id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether two Jellyfin user ids are the same account.
 *
 * Jellyfin hands GUIDs back in whichever shape the serialiser felt like, and these two come from
 * different places — the owner from StingStream's own route, the row from `GET /Users`. Comparing
 * them as plain strings is the bug `sameLibraryId` already exists for one level down.
 */
export const sameUserId = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean =>
  Boolean(a) &&
  Boolean(b) &&
  (a as string).replace(/-/g, "").toLowerCase() ===
    (b as string).replace(/-/g, "").toLowerCase();
