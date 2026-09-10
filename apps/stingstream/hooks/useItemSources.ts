/**
 * The "Play from…" data: every node in the group that holds this title, scored.
 *
 * Gated hard on the item actually being federated — at least one `MediaSource.Path` that parses as
 * a mesh pointer. `GET /items/{id}/sources` is a mesh round trip per call, and asking it about the
 * ordinary local films that make up most of a library would put a group-index read behind every
 * pre-play screen for an answer that is always "this server, and nothing else".
 *
 * Keyed on the policy as well as the item because the answer genuinely differs: the server ranks
 * under whichever policy it is told, and flipping the tab in the chooser must not show the previous
 * policy's order while the new one loads.
 */

import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  buildSourceChoices,
  type PlaybackPolicy,
  type SourceChoice,
} from "@/lib/stingstream/sourceChooser";
import {
  fetchItemSources,
  type ItemSourcesResponse,
} from "@/lib/stingstream/sources";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import { parseMeshStreamUrl } from "@/utils/mesh/streamUrl";

/** True when any of this item's sources is a federated pointer. */
export const isFederatedItem = (
  item: BaseItemDto | null | undefined,
): boolean =>
  (item?.MediaSources ?? []).some((source) =>
    Boolean(parseMeshStreamUrl(source.Path)),
  );

export interface UseItemSourcesOptions {
  /** Override the device policy — the chooser's tabs preview the other one. */
  policy?: PlaybackPolicy;
  /** Skip the request entirely (the chooser is closed, the player is offline). */
  enabled?: boolean;
}

export interface UseItemSourcesResult {
  data: ItemSourcesResponse | null | undefined;
  isLoading: boolean;
  isError: boolean;
  /** The item is federated at all — what decides whether a chooser is worth offering. */
  federated: boolean;
  policy: PlaybackPolicy;
}

export const useItemSources = (
  item: BaseItemDto | null | undefined,
  options: UseItemSourcesOptions = {},
): UseItemSourcesResult => {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const { settings } = useSettings();
  const policy = options.policy ?? settings.playbackPolicy;

  const federated = useMemo(() => isFederatedItem(item), [item]);
  const itemId = item?.Id ?? null;
  const enabled =
    (options.enabled ?? true) && federated && !!itemId && !!api?.basePath;

  const query = useQuery({
    queryKey: ["stingstream", "sources", itemId, policy],
    enabled,
    // The group index moves — a holder wakes up, a pin finishes — but not between two taps, and a
    // refetch on every focus would put a mesh round trip behind returning from the player.
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      fetchItemSources(getStingStreamApiBaseUrl(api?.basePath ?? ""), itemId!, {
        accessToken: api?.accessToken,
        policy,
        userId: user?.Id,
        signal,
      }),
  });

  return {
    data: query.data,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    federated,
    policy,
  };
};

export interface UseSourceChoicesResult extends UseItemSourcesResult {
  choices: SourceChoice[];
  /** Worth showing a chooser at all: more than one thing to pick between. */
  hasChoice: boolean;
}

/**
 * The chooser's rows: the fetch above joined to `item.MediaSources`.
 *
 * Kept beside the query rather than in the sheet so the pre-play button, the in-player pill and the
 * TV modal all read the same list — three call sites that must agree about which row is
 * recommended, or the badge means nothing.
 */
export const useSourceChoices = (
  item: BaseItemDto | null | undefined,
  options: UseItemSourcesOptions & {
    currentMediaSourceId?: string | null;
  } = {},
): UseSourceChoicesResult => {
  const { t } = useTranslation();
  const { currentMediaSourceId, ...queryOptions } = options;
  const result = useItemSources(item, queryOptions);

  const choices = useMemo(
    () =>
      buildSourceChoices(item?.MediaSources, result.data, {
        currentMediaSourceId,
        policy: result.policy,
        localLabel: t("player.source.this_server"),
      }),
    [item?.MediaSources, result.data, result.policy, currentMediaSourceId, t],
  );

  return { ...result, choices, hasChoice: choices.length > 1 };
};

