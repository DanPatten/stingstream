import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getItemsApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import type React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ViewProps } from "react-native";
import { CardRow } from "@/components/cards/CardRow";
import { RequestableRow } from "@/components/stingstream/requests/RequestableRow";
import {
  useActorCredits,
  useRequestsAvailable,
  withoutCurrentTitle,
} from "@/lib/stingstream/requests";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";

interface Props extends ViewProps {
  actorId: string;
  actorName?: string | null;
  currentItem: BaseItemDto;
}

/**
 * Everything this person appears in, whoever holds it.
 *
 * It used to be a `personIds` query against the local library, so an actor with
 * two films here and thirty elsewhere read as an actor with two films. The node
 * asks the metadata provider instead and annotates each result with what the
 * group holds. Dan, 2026-09-12.
 *
 * **The node cannot exclude by Jellyfin id, so the "not the title I am standing
 * on" rule moved here.** `excludeItemIds` did it before; the catalogue knows
 * nothing about this library's ids, and `localItemId` is the only field that
 * can answer it — which also means it only ever excludes a title the library
 * actually holds, which is the only kind that could be the current one.
 *
 * The library query survives as the fallback for a node that cannot read the
 * catalogue. See `SimilarItems` for the whole reasoning.
 */
export const MoreMoviesWithActor: React.FC<Props> = ({
  actorId,
  actorName,
  currentItem,
  ...props
}) => {
  const [api] = useAtom(apiAtom);
  const [user] = useAtom(userAtom);
  const { t } = useTranslation();

  const available = useRequestsAvailable();
  const credits = useActorCredits(actorId, available.data === true);

  // Guarded on the id existing, not just on the two being unequal. A title nobody holds has no
  // `localItemId` at all, and a film has no `SeriesId` -- so an unguarded `!==` compared undefined
  // with undefined, called it a match, and dropped every title the library does not have. Which is
  // the entire row.
  const shown = useMemo(
    () =>
      withoutCurrentTitle(
        credits.data ?? [],
        currentItem.Id,
        currentItem.SeriesId,
      ),
    [credits.data, currentItem.Id, currentItem.SeriesId],
  );

  const { data: items, isLoading } = useQuery({
    queryKey: ["actor", "movies", actorId, currentItem.Id],
    queryFn: async () => {
      if (!api || !user?.Id) return [];
      const response = await getItemsApi(api).getItems({
        userId: user.Id,
        personIds: [actorId],
        limit: 20,
        sortOrder: ["Descending"],
        includeItemTypes: ["Movie", "Series"],
        recursive: true,
        fields: ["ParentId", "PrimaryImageAspectRatio"],
        sortBy: ["PremiereDate"],
        collapseBoxSetItems: false,
        excludeItemIds: [currentItem.SeriesId || "", currentItem.Id || ""],
      });

      // Remove duplicates based on item ID
      const uniqueItems =
        response.data.Items?.reduce((acc, current) => {
          const x = acc.find((item) => item.Id === current.Id);
          if (!x) {
            return acc.concat([current]);
          }
          return acc;
        }, [] as BaseItemDto[]) || [];

      return uniqueItems;
    },
    enabled: available.data === false && !!api && !!user?.Id && !!actorId,
  });

  const title = t("item_card.more_with", { name: actorName ?? "" });

  if (available.data === false) {
    return (
      <CardRow
        enableActionSheet
        {...props}
        title={title}
        kind='portrait'
        items={items ?? []}
        loading={isLoading}
        hideIfEmpty
      />
    );
  }

  return (
    <RequestableRow
      {...props}
      title={title}
      results={shown}
      loading={available.isLoading || credits.isLoading}
    />
  );
};
