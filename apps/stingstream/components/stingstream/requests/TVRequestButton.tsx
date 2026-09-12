import { Ionicons } from "@expo/vector-icons";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useCallback, useMemo } from "react";
import { TVButton } from "@/components/tv/TVButton";
import { useRequests } from "@/lib/stingstream/requests";
import { scaleSize } from "@/utils/scaleSize";
import { useAskForTitle } from "./useAskForTitle";

/**
 * "Ask for the rest of this" — the one request action a ten-foot remote gets.
 *
 * Deliberately read-only in the sense that matters: there is no season picker, no policy, no
 * approvals. A D-pad is a bad instrument for a multi-select, and everything this button cannot do
 * is a phone away. What it *can* do is the case that actually comes up on a television — you are
 * looking at a series whose later seasons the group does not hold, and you want them.
 *
 * Only shown for a series with a TVDB id, or a movie with a TMDB id. Without a provider id there is
 * no item key, and without an item key the node has nothing to look up, dedupe against or ask an
 * arr for; offering a button that could only fail would be worse than not offering one.
 */
export function TVRequestButton({
  item,
  minHeight,
}: {
  item: BaseItemDto | null | undefined;
  /** Shared with the other buttons in its row, so the row is not ragged. */
  minHeight?: number;
}) {
  const { ask: askFor, pending } = useAskForTitle();
  // Every request this node knows about, so a title already asked for says so rather than being
  // asked for twice. The node collapses a duplicate onto the open request anyway; this is about
  // what the button *says*.
  const requests = useRequests({ mine: true });

  const target = useMemo(() => {
    if (!item) return null;
    const providers = item.ProviderIds ?? {};
    if (item.Type === "Series") {
      const tvdb = Number.parseInt(String(providers.Tvdb ?? ""), 10);
      return Number.isFinite(tvdb) && tvdb > 0
        ? { tvdbId: tvdb, itemKey: `episode:tvdb:${tvdb}:` }
        : null;
    }
    if (item.Type === "Movie") {
      const tmdb = Number.parseInt(String(providers.Tmdb ?? ""), 10);
      return Number.isFinite(tmdb) && tmdb > 0
        ? { tmdbId: tmdb, itemKey: `movie:tmdb:${tmdb}` }
        : null;
    }
    return null;
  }, [item]);

  const existing = useMemo(
    () =>
      target
        ? (requests.data ?? []).find(
            (r) => r.itemKey === target.itemKey && r.state !== "declined",
          )
        : undefined,
    [requests.data, target],
  );

  // The ask itself lives in `useAskForTitle`, shared with the poster on a related or filmography
  // row, so a press means the same thing and says the same thing wherever it happens on a
  // television.
  const ask = useCallback(async () => {
    if (!target || !item) return;
    await askFor({
      tmdbId: "tmdbId" in target ? target.tmdbId : undefined,
      tvdbId: "tvdbId" in target ? target.tvdbId : undefined,
      title: item.Name,
      year: item.ProductionYear,
    });
  }, [askFor, item, target]);

  if (!target) return null;

  const asked = existing !== undefined;
  return (
    <TVButton
      onPress={ask}
      variant='glass'
      square
      disabled={pending || asked}
      minHeight={minHeight}
    >
      <Ionicons
        name={asked ? "checkmark-circle-outline" : "add-circle-outline"}
        size={scaleSize(28)}
        color='#FFFFFF'
      />
    </TVButton>
  );
}
