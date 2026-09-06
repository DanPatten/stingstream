/**
 * "Play from…": turning two half-answers into one list the user can act on.
 *
 * The player can only play a **MediaSource** — a thing Jellyfin has an id for. The mesh only knows
 * about **sources** — nodes that hold the file, with a measured round trip and a bitrate
 * (`lib/stingstream/sources.ts`). Neither is the menu on its own:
 *
 *  * `item.MediaSources` says what is playable but not how good or how close it is. A federated
 *    title's entries are `.strm` pointers whose only distinguishing feature is a URL.
 *  * `GET /items/{id}/sources` says which holder is fastest but hands back a `stingstream.local`
 *    URL the player has no session for.
 *
 * So this joins them on the node id the pointer carries, and everything below is a pure function of
 * that join. The join is also the reason a source can vanish from the menu: a holder this node
 * never materialized a `.strm` for has no MediaSource, hence no id, hence nothing to play — see
 * `docs/UI-API-GAPS.md`.
 *
 * ## Why the client re-sorts a list the server already sorted
 *
 * The server ranks under *its* policy, which belongs to the node, not to the person holding the
 * phone. `settings.playbackPolicy` is per-device on purpose — the same library is watched on a
 * laptop on fibre and a tablet on hotel wifi — so when the two disagree the client's wins, and the
 * recommendation moves with it. `response.policy` is what the server used; the `policy` option is
 * what this device wants.
 */

import type { MediaSourceInfo } from "@jellyfin/sdk/lib/generated-client/models";
import { parseMeshStreamUrl } from "@/utils/mesh/streamUrl";
import {
  bestOnlineSource,
  type ItemSource,
  type ItemSourcesResponse,
} from "./sources";

/** Which end of the trade-off a device leans on. Mirrors the server's `PolicyNames`. */
export type PlaybackPolicy = "speed_first" | "quality_first";

/** How the bytes reach this device, once a connection has been measured. */
export type SourceRoute = "direct" | "relayed" | "connecting" | "local";

/** One row of the "Play from…" menu. */
export interface SourceChoice {
  /** What `switchMediaSource` needs: the id the player negotiates a stream for. */
  mediaSourceId: string;
  /** The holder's node id, or `null` for the copy on this server. */
  node: string | null;
  /** What the row is called: the holder's name, or the "This server" label. */
  nodeName: string;
  /** The file lives on the server this device is signed in to — no mesh hop at all. */
  local: boolean;
  online: boolean;
  /** The row the client policy would pick. Exactly one choice carries it, when any can. */
  recommended: boolean;
  /** The source currently playing. */
  current: boolean;
  /** Byte-identical to the source currently playing, by `fileHash`. */
  sameFileAsCurrent: boolean;
  /** Offline holders are listed so the user can see they exist, and cannot be chosen. */
  disabled: boolean;
  route: SourceRoute;
  /** `2160p`, or whatever the holder's index recorded. */
  resolution: string | null;
  height: number | null;
  /** Bits per second. */
  bitrate: number | null;
  rttMs: number | null;
  fileHash: string | null;
}

export interface BuildSourceChoicesOptions {
  /** `MediaSourceInfo.Id` of the source playing now, so the list can mark it. */
  currentMediaSourceId?: string | null;
  /** This device's policy, which outranks the server's for ordering and the recommendation. */
  policy: PlaybackPolicy;
  /** Translated label for the copy held by the server the user is signed in to. */
  localLabel: string;
}

// --- the join --------------------------------------------------------------------------------

/**
 * Everything the user can play this title from, best first under `policy`.
 *
 * Offline holders sort last and come back `disabled`, rather than being dropped: "Dan's PC has it
 * but is switched off" is the answer to "why is this only available in 720p", and hiding it turns
 * that into a mystery.
 */
export function buildSourceChoices(
  mediaSources: readonly MediaSourceInfo[] | null | undefined,
  response: ItemSourcesResponse | null | undefined,
  options: BuildSourceChoicesOptions,
): SourceChoice[] {
  const { currentMediaSourceId, policy, localLabel } = options;
  const byNode = new Map<string, ItemSource>();
  for (const source of response?.sources ?? []) {
    if (source.node) byNode.set(source.node.toLowerCase(), source);
  }

  const choices: SourceChoice[] = [];
  const locals: Array<{ choice: SourceChoice; mediaSource: MediaSourceInfo }> = [];
  for (const mediaSource of mediaSources ?? []) {
    const id = mediaSource.Id;
    if (!id) continue;

    const target = parseMeshStreamUrl(mediaSource.Path);
    if (target) {
      const source = byNode.get(target.node.toLowerCase());
      // A pointer whose holder the group index no longer lists is a stale `.strm`. Playing it
      // would stall on a peer handshake that cannot complete, so it is not offered.
      if (!source) continue;
      choices.push(fromMeshSource(id, source, mediaSource));
      continue;
    }

    // Not a mesh pointer. A remote path this node did not write is somebody else's business
    // (a Live TV tuner, an http source added by hand) and has no place in a holder menu.
    if (mediaSource.IsRemote) continue;
    const choice = fromLocalSource(id, mediaSource, localLabel);
    choices.push(choice);
    locals.push({ choice, mediaSource });
  }

  // One server, two files: a folder holding a 1080p and a 720p cut of the same film is an ordinary
  // library, and two rows both reading "This server" would be a coin toss. Naming them only in
  // this case keeps the common one — a single local copy — reading as the place rather than the
  // file.
  if (locals.length > 1) {
    for (const { choice, mediaSource } of locals) {
      const name = localSourceName(mediaSource);
      if (name) choice.nodeName = `${localLabel} · ${name}`;
    }
  }

  const currentHash = choices.find(
    (c) => c.mediaSourceId === currentMediaSourceId,
  )?.fileHash;

  const marked = choices.map((choice) => ({
    ...choice,
    current: choice.mediaSourceId === currentMediaSourceId,
    sameFileAsCurrent:
      !!currentHash &&
      !!choice.fileHash &&
      choice.fileHash === currentHash &&
      choice.mediaSourceId !== currentMediaSourceId,
  }));

  const ordered = [...marked].sort(comparator(policy));
  const recommendedId = recommendedMediaSourceId(ordered, response, policy);

  return ordered.map((choice) => ({
    ...choice,
    recommended: choice.mediaSourceId === recommendedId,
  }));
}

const fromMeshSource = (
  mediaSourceId: string,
  source: ItemSource,
  mediaSource: MediaSourceInfo,
): SourceChoice => ({
  mediaSourceId,
  node: source.node,
  nodeName: source.nodeName || source.node.slice(0, 8),
  local: false,
  online: source.online,
  recommended: false,
  current: false,
  sameFileAsCurrent: false,
  disabled: !source.online,
  route: routeOf(source.path),
  resolution: source.resolution ?? resolutionOf(source.height ?? null),
  height: source.height ?? null,
  bitrate: source.bitrate ?? null,
  rttMs: source.rttMs ?? null,
  fileHash: normaliseHash(
    source.fileHash ?? fileHashFromETag(mediaSource.ETag),
  ),
});

const fromLocalSource = (
  mediaSourceId: string,
  mediaSource: MediaSourceInfo,
  localLabel: string,
): SourceChoice => {
  const video = mediaSource.MediaStreams?.find((s) => s.Type === "Video");
  const height = video?.Height ?? null;
  return {
    mediaSourceId,
    node: null,
    nodeName: localLabel,
    local: true,
    // A file on the server this device is already talking to is reachable by definition: if it
    // were not, there would be no library to be looking at.
    online: true,
    recommended: false,
    current: false,
    sameFileAsCurrent: false,
    disabled: false,
    route: "local",
    resolution: resolutionOf(height),
    height,
    bitrate: mediaSource.Bitrate ?? video?.BitRate ?? null,
    // There is no hop to measure, and a menu that prints "0 ms" next to a local file invites the
    // reading that it was measured and came back fast.
    rttMs: null,
    // The local file has no entry in the scored list to take a hash from, so the ETag is the only
    // way "the copy on your server is the same file as the one on Dan's" can ever be known.
    fileHash: normaliseHash(fileHashFromETag(mediaSource.ETag)),
  };
};

/**
 * The holder's file hash out of a MediaSource's weak ETag.
 *
 * Core stamps every federated `MediaSource` with `W/"b3-<hash>"` — the same `stingstream:file_hash`
 * the scored source list returns — precisely so a client can tell "the same bytes somewhere else,
 * resume silently" from "a different encode, restart at a timestamp" (`docs/UI-API-GAPS.md`). It is
 * the only hash the *local* copy has, since the local copy is not a mesh source at all.
 */
export const fileHashFromETag = (
  etag: string | null | undefined,
): string | null => {
  if (!etag) return null;
  const unquoted = etag.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  const hash = unquoted.replace(/^b3-/i, "");
  return hash.length > 0 ? hash : null;
};

/** Both spellings of the same hash compare equal. */
const normaliseHash = (hash: string | null | undefined): string | null =>
  hash ? hash.replace(/^b3-/i, "").toLowerCase() : null;

/** What tells one local file from another: what the player's own source picker calls it. */
const localSourceName = (mediaSource: MediaSourceInfo): string | null => {
  const video = mediaSource.MediaStreams?.find((s) => s.Type === "Video");
  return mediaSource.Name || video?.DisplayTitle || null;
};

const routeOf = (path: string | null | undefined): SourceRoute => {
  if (path === "direct" || path === "mixed") return "direct";
  if (path === "relay") return "relayed";
  return "connecting";
};

/** The nearest standard label for a pixel height, so `1088` does not read as a resolution. */
export const resolutionOf = (height: number | null): string | null => {
  if (!height || height <= 0) return null;
  if (height >= 2000) return "2160p";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  if (height >= 500) return "576p";
  return "480p";
};

// --- ordering --------------------------------------------------------------------------------

const ROUTE_RANK: Record<SourceRoute, number> = {
  // Nothing to negotiate beats a negotiated hop, and a measured hop beats one that has not
  // connected yet — "connecting" is the absence of evidence, not evidence of speed.
  local: 3,
  direct: 2,
  relayed: 1,
  connecting: 0,
};

const num = (value: number | null, fallback: number): number =>
  value == null ? fallback : value;

/**
 * The comparator each policy sorts by, exported so the pre-play chooser and the in-player pill
 * agree about what "first" means.
 *
 * Offline last in both, because a holder that cannot serve a byte is not a faster or a
 * higher-quality anything.
 */
export const comparator =
  (policy: PlaybackPolicy) =>
  (a: SourceChoice, b: SourceChoice): number => {
    if (a.online !== b.online) return a.online ? -1 : 1;

    if (policy === "quality_first") {
      // The best encode wins even if it is the far side of a relay: the user asked for quality
      // and buffering is the price they said they would pay.
      const height = num(b.height, -1) - num(a.height, -1);
      if (height !== 0) return height;
      const bitrate = num(b.bitrate, -1) - num(a.bitrate, -1);
      if (bitrate !== 0) return bitrate;
      const route = ROUTE_RANK[b.route] - ROUTE_RANK[a.route];
      if (route !== 0) return route;
    } else {
      const route = ROUTE_RANK[b.route] - ROUTE_RANK[a.route];
      if (route !== 0) return route;
      // An unmeasured hop sorts behind every measured one rather than ahead of them, which is
      // what a 0 default would do.
      const rtt =
        num(a.rttMs, Number.POSITIVE_INFINITY) -
        num(b.rttMs, Number.POSITIVE_INFINITY);
      if (rtt !== 0) return rtt;
      const height = num(b.height, -1) - num(a.height, -1);
      if (height !== 0) return height;
    }

    return a.nodeName.localeCompare(b.nodeName);
  };

/**
 * Which row wears the "Recommended" badge.
 *
 * `bestOnlineSource` is the server's answer and is taken as-is when the two policies agree —
 * it saw scoring inputs the client never receives. When they disagree the client re-sorts, because
 * the whole point of a per-device policy is that this device gets what it asked for.
 */
const recommendedMediaSourceId = (
  ordered: readonly SourceChoice[],
  response: ItemSourcesResponse | null | undefined,
  policy: PlaybackPolicy,
): string | null => {
  const playable = ordered.filter((c) => !c.disabled);
  if (playable.length === 0) return null;

  if (response && response.policy === policy) {
    const best = bestOnlineSource(response);
    const match = best
      ? playable.find((c) => c.node?.toLowerCase() === best.node.toLowerCase())
      : undefined;
    if (match) return match.mediaSourceId;
    // The server's pick has no MediaSource on this node (the local copy is the usual reason, since
    // a title held here is never materialized as a pointer). Falling through to the client
    // ordering below keeps the badge on a row that exists.
  }

  return playable[0].mediaSourceId;
};

// --- presentation ----------------------------------------------------------------------------

/** The translated words `formatSourceChoice` needs, so the formatter itself stays pure. */
export interface SourceChoiceLabels {
  direct: string;
  relayed: string;
  connecting: string;
  offline: string;
  recommended: string;
  sameFile: string;
  playing: string;
}

export interface FormattedSourceChoice {
  title: string;
  /** `2160p · 45 Mb/s · 18 ms · Direct` — whichever of those four are known. */
  subtitle: string;
  badges: string[];
}

/** `45 Mb/s`, `4.5 Mb/s`, `800 kb/s` — one significant place only where it earns one. */
export const formatBitrate = (bps: number | null): string | null => {
  if (!bps || bps <= 0) return null;
  if (bps >= 10_000_000) return `${Math.round(bps / 1_000_000)} Mb/s`;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mb/s`;
  return `${Math.round(bps / 1000)} kb/s`;
};

/** One row's three visible parts. */
export const formatSourceChoice = (
  choice: SourceChoice,
  labels: SourceChoiceLabels,
): FormattedSourceChoice => {
  const parts: string[] = [];
  if (choice.resolution) parts.push(choice.resolution);
  const bitrate = formatBitrate(choice.bitrate);
  if (bitrate) parts.push(bitrate);
  if (choice.rttMs != null) parts.push(`${Math.round(choice.rttMs)} ms`);
  if (choice.route === "direct") parts.push(labels.direct);
  else if (choice.route === "relayed") parts.push(labels.relayed);
  else if (choice.route === "connecting") parts.push(labels.connecting);

  const badges: string[] = [];
  if (choice.current) badges.push(labels.playing);
  if (choice.recommended) badges.push(labels.recommended);
  if (choice.sameFileAsCurrent) badges.push(labels.sameFile);
  if (!choice.online) badges.push(labels.offline);

  return { title: choice.nodeName, subtitle: parts.join(" · "), badges };
};
