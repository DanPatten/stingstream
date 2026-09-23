/**
 * "Show in Explorer" in Get info: the node opens its own file manager with a title's file
 * selected. `POST /stingstream/reveal` on the gateway, see `gateway/reveal.rs` and
 * docs/ARCHITECTURE.md ("Show in Explorer").
 *
 * The pure half, free of React and react-native so `reveal.test.ts` can pin who sees the button.
 *
 * Who sees it is decided twice, and both have to agree. The node answers `canReveal` from
 * `GET /stingstream/reveal`, which is true only for a browser on the node's own machine (the TCP
 * peer is loopback, and nothing relayed it) on an OS it can drive. The app adds what only it
 * knows: this is the web build rather than a phone or a TV, and the signed-in user is an
 * administrator, the same people who see a path at all.
 */

/** Where the gateway answers, relative to the node's base URL. */
export const REVEAL_PATH = "/stingstream/reveal";

export type RevealPlatform = "windows";

export interface RevealCapability {
  canReveal: boolean;
  platform: RevealPlatform | null;
}

export const NO_REVEAL: RevealCapability = { canReveal: false, platform: null };

/** The gateway's answer, read defensively: anything unexpected is "no". */
export function parseRevealCapability(body: unknown): RevealCapability {
  if (!body || typeof body !== "object") return NO_REVEAL;
  const { canReveal, platform } = body as Record<string, unknown>;
  if (canReveal !== true || platform !== "windows") return NO_REVEAL;
  return { canReveal: true, platform };
}

export interface RevealContext {
  /** `Platform.OS`. */
  os: string;
  /** `Platform.isTV`. */
  isTV: boolean;
  isAdmin: boolean;
  /** `undefined` while the node has not answered. */
  capability: RevealCapability | undefined;
}

/** Whether Get info draws "Show in Explorer" beside "Copy path". */
export function shouldShowReveal({
  os,
  isTV,
  isAdmin,
  capability,
}: RevealContext): boolean {
  return (
    os === "web" &&
    !isTV &&
    isAdmin &&
    capability?.canReveal === true &&
    capability.platform !== null
  );
}

/**
 * Why a reveal failed, as the suffix of its `item_info.reveal_*` string. A suffix rather than the
 * whole key, so the caller's template-literal `t()` is what the i18n check sees as a prefix.
 */
export type RevealFailure =
  | "file_missing"
  | "remote_file"
  | "not_here"
  | "failed";

/** The toast for a refusal, by the gateway's `error` code. */
export function revealFailure(code: string | undefined): RevealFailure {
  switch (code) {
    case "file_missing":
      return "file_missing";
    case "no_local_file":
      return "remote_file";
    case "not_local":
    case "unsupported":
      return "not_here";
    default:
      return "failed";
  }
}

/** Ask the node which of the above it can do for this browser. */
export async function fetchRevealCapability(
  nodeBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RevealCapability> {
  try {
    const res = await fetchImpl(`${nodeBaseUrl}${REVEAL_PATH}`);
    // A node too old to have the route answers 404 or the web bundle's index.html.
    if (!res.ok) return NO_REVEAL;
    return parseRevealCapability(await res.json());
  } catch {
    return NO_REVEAL;
  }
}

/**
 * Open the folder holding one version of an item. On a refusal, the gateway's `error` code, or
 * `undefined` when it gave none (a network failure, a node too old to have the route).
 */
export async function revealItem(
  nodeBaseUrl: string,
  accessToken: string,
  itemId: string,
  mediaSourceId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; code: string | undefined }> {
  try {
    const res = await fetchImpl(`${nodeBaseUrl}${REVEAL_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `MediaBrowser Token="${accessToken}"`,
      },
      body: JSON.stringify(
        mediaSourceId ? { itemId, mediaSourceId } : { itemId },
      ),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    return {
      ok: false,
      code: typeof body?.error === "string" ? body.error : undefined,
    };
  } catch {
    return { ok: false, code: undefined };
  }
}
