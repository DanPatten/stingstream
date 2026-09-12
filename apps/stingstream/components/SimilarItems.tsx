import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getLibraryApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import type { ViewProps } from "react-native";
import { CardRow } from "@/components/cards/CardRow";
import { RequestableRow } from "@/components/stingstream/requests/RequestableRow";
import {
  useRelatedTitles,
  useRequestsAvailable,
} from "@/lib/stingstream/requests";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";

interface SimilarItemsProps extends ViewProps {
  itemId?: string | null;
}

/**
 * "Related" — what this is like, whoever holds it.
 *
 * Movies *and* series, where this used to filter everything but `Movie` away and
 * then draw "No similar items found" under a heading on every episode page. A
 * section with nothing in it is not a section: `hideIfEmpty` takes it off the
 * page instead of leaving a heading over an apology.
 *
 * **It is the catalogue's answer now, not the library's.** It used to be
 * `getSimilarItems`, which can only ever answer with titles already on this
 * disk — so a row under a film was not "what this is related to", it was the
 * part of that which happened to be here, with no sign the rest existed. The
 * node asks the metadata provider and annotates every result with what the
 * group holds, so a held title carries a play disc and its own page while
 * everything else carries a plus and opens the request sheet. Dan, 2026-09-12.
 *
 * The library query stays, as the fallback for a node that cannot read the
 * catalogue at all. A node with no managers and a blanked key still has a
 * library, and a Related row that works the way it always has beats a section
 * that vanishes. `useRequestsAvailable` is one probe shared by every row on the
 * page, and while it is in flight this draws the loading row rather than
 * nothing — returning null there would pop the section in a beat after the page
 * settled, which is the bug `ItemPeopleSections` already records fixing once.
 */
export const SimilarItems: React.FC<SimilarItemsProps> = ({
  itemId,
  ...props
}) => {
  const [api] = useAtom(apiAtom);
  const [user] = useAtom(userAtom);
  const { t } = useTranslation();

  const available = useRequestsAvailable();
  const catalogue = useRelatedTitles(itemId, available.data === true);

  const { data: similarItems, isLoading } = useQuery<BaseItemDto[]>({
    queryKey: ["similarItems", itemId],
    queryFn: async () => {
      if (!api || !user?.Id || !itemId) return [];
      const response = await getLibraryApi(api).getSimilarItems({
        itemId,
        userId: user.Id,
        limit: 12,
      });

      return response.data.Items || [];
    },
    enabled: available.data === false && !!api && !!user?.Id && !!itemId,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (available.data === false) {
    return (
      <CardRow
        enableActionSheet
        {...props}
        title={t("item.related")}
        kind='portrait'
        items={similarItems ?? []}
        loading={isLoading}
        hideIfEmpty
      />
    );
  }

  return (
    <RequestableRow
      {...props}
      title={t("item.related")}
      results={catalogue.data}
      loading={available.isLoading || catalogue.isLoading}
    />
  );
};
