import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getLibraryApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import type { ViewProps } from "react-native";
import { CardRow } from "@/components/cards/CardRow";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";

interface SimilarItemsProps extends ViewProps {
  itemId?: string | null;
}

/**
 * "Related" — what the server thinks is like this.
 *
 * Films *and* series, where this used to filter everything but `Movie` away and
 * then draw "No similar items found" under a heading on every episode page. A
 * section with nothing in it is not a section: `hideIfEmpty` takes it off the
 * page instead of leaving a heading over an apology.
 */
export const SimilarItems: React.FC<SimilarItemsProps> = ({
  itemId,
  ...props
}) => {
  const [api] = useAtom(apiAtom);
  const [user] = useAtom(userAtom);
  const { t } = useTranslation();

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
    enabled: !!api && !!user?.Id && !!itemId,
    staleTime: Number.POSITIVE_INFINITY,
  });

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
};
