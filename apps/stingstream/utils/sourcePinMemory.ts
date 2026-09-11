import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import { storage } from "@/utils/mmkv";

/**
 * "Always play this one from Dan's PC."
 *
 * Auto — score every copy afresh each time — is the default and is right almost always: it follows
 * a peer going offline, a link degrading, a better encode appearing. A pin is the deliberate
 * override, and it is remembered so that making it once means making it once.
 *
 * ## Why the node id, and not the media-source id
 *
 * A `MediaSource.Id` is Jellyfin's row identity for a materialized `.strm`, and it changes when the
 * library rescans or the materializer rewrites the pointer. A pin stored against one silently
 * becomes a pin against nothing within a week, which reads as the setting not sticking. The 64-hex
 * node id inside `https://stingstream.local/stream/<group>/<key>/<node>` is the identity of the
 * *machine*, and that does not move. `null` means the copy on this server, which has exactly one
 * identity and no node id of its own.
 *
 * ## Why per device
 *
 * The same reason `settings.playbackPolicy` is per device: the same library is watched on a laptop
 * on fibre and a tablet on hotel wifi, and the 4K peer that is the obvious pick on one is the one
 * that stalls on the other. A per-title override of a per-device policy that was itself
 * account-wide would be incoherent.
 */
export interface SourcePin {
  /** The holder's mesh node id, or `null` for the copy on this server. */
  node: string | null;
  /**
   * What that holder was called when it was pinned.
   *
   * Stored rather than looked up, because the one moment it is needed is the moment the holder is
   * not in the list any more — "Attic PC no longer has this" is a sentence that cannot be written
   * from a node id alone, and "a server you chose no longer has this" is not worth saying.
   */
  serverName?: string;
  /**
   * BLAKE3 of the pinned file, when it was known.
   *
   * Only used to tell two local cuts apart — a folder holding a 1080p and a 720p of the same movie
   * gives two rows that both mean "this server", and the node id cannot separate them.
   */
  fileHash?: string;
  updatedAt: number;
}

const STORAGE_KEY = "sourcePinMemory.v1";

/**
 * How many titles keep a pin.
 *
 * Bounded for the same reason the series track memory is: this is a convenience written to a
 * device's own storage, not a record anybody would miss. Two hundred is more titles than a person
 * pins by hand in the life of a device, and evicting the least recently set is the eviction least
 * likely to be noticed.
 */
const MAX_PINNED = 200;

type PinMap = Record<string, SourcePin>;

const readAll = (): PinMap => {
  try {
    const raw = storage.getString(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PinMap;
  } catch {
    // A private window, cleared storage, or a half-written blob. An empty map means Auto, which is
    // the correct behaviour for "we do not know what you chose".
    return {};
  }
};

const writeAll = (all: PinMap): void => {
  try {
    storage.set(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Losing a pin is a worse experience than a crash would be a better one.
  }
};

/**
 * Where a pin is filed.
 *
 * An episode is filed under its **series**, so "play this show from the attic box" is one decision
 * every episode inherits rather than one a person makes fifty times. It degrades correctly too: an
 * episode that box does not hold falls back to Auto on its own, without disturbing the rest.
 */
export const sourcePinKey = (
  item: BaseItemDto | null | undefined,
): string | null => {
  if (!item) return null;
  if (item.Type === "Episode") return item.SeriesId ?? item.Id ?? null;
  return item.Id ?? null;
};

/** The pin for one title, or undefined for Auto. */
export const getSourcePin = (
  key: string | null | undefined,
): SourcePin | undefined => (key ? readAll()[key] : undefined);

/** Remember a deliberate pick. */
export const rememberSourcePin = (
  key: string | null | undefined,
  pin: Omit<SourcePin, "updatedAt">,
): void => {
  if (!key) return;
  const all = readAll();
  all[key] = { ...pin, updatedAt: Date.now() };

  const keys = Object.keys(all);
  if (keys.length > MAX_PINNED) {
    const oldest = keys
      .sort((a, b) => (all[a].updatedAt ?? 0) - (all[b].updatedAt ?? 0))
      .slice(0, keys.length - MAX_PINNED);
    for (const id of oldest) delete all[id];
  }

  writeAll(all);
};

/** Go back to Auto for one title. */
export const clearSourcePin = (key: string | null | undefined): void => {
  if (!key) return;
  const all = readAll();
  if (!(key in all)) return;
  delete all[key];
  writeAll(all);
};
