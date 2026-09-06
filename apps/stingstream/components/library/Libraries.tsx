import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import {
  getUserLibraryApi,
  getUserViewsApi,
} from "@jellyfin/sdk/lib/utils/api";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState } from "@/components/common/EmptyState";
import { PageContainer } from "@/components/common/PageContainer";
import { Loader } from "@/components/Loader";
import { LibraryItemCard } from "@/components/library/LibraryItemCard";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";

/** 2 columns on a phone, 3 on a tablet/narrow browser, 4 on a wide one. */
const COLUMNS = { compact: 2, medium: 3, expanded: 4 } as const;
const ROW_GAP = 16;
const COLUMN_GAP = 16;

export const Libraries: React.FC = () => {
  const [api] = useAtom(apiAtom);
  const [user] = useAtom(userAtom);
  const queryClient = useQueryClient();
  const { settings } = useSettings();
  const { name: breakpointName } = useBreakpoint();

  const { t } = useTranslation();

  const { data, isLoading } = useQuery({
    queryKey: ["user-views", user?.Id],
    queryFn: async () => {
      const response = await getUserViewsApi(api!).getUserViews({
        userId: user?.Id,
      });

      return response.data.Items || null;
    },
    staleTime: 60,
    // On logout the cached query refetches with api null and crashes inside
    // the SDK (`configuration` of null).
    enabled: !!api && !!user?.Id,
  });

  const libraries = useMemo(
    () =>
      data
        ?.filter((l) => !settings?.hiddenLibraries?.includes(l.Id!))
        .filter((l) => l.CollectionType !== "books") || [],
    [data, settings?.hiddenLibraries],
  );

  useEffect(() => {
    for (const item of data || []) {
      queryClient.prefetchQuery({
        queryKey: ["library", item.Id],
        queryFn: async () => {
          if (!item.Id || !user?.Id || !api) return null;
          const response = await getUserLibraryApi(api).getItem({
            itemId: item.Id,
            userId: user?.Id,
          });
          return response.data;
        },
        staleTime: 60 * 1000,
      });
    }
  }, [data, api, queryClient, user?.Id]);

  const insets = useSafeAreaInsets();
  const columns = COLUMNS[breakpointName];

  if (isLoading)
    return (
      <View className='justify-center items-center h-full'>
        <Loader />
      </View>
    );

  if (libraries.length === 0)
    return <EmptyState title={t("library.no_libraries_found")} />;

  return (
    <PageContainer width='media' style={{ flex: 1 }}>
      <FlashList
        testID='library-grid'
        // The column count changes with the breakpoint; React Native does not
        // re-layout `numColumns` on its own, so a resize across a breakpoint
        // needs a remount to show the new column count.
        key={columns}
        contentInsetAdjustmentBehavior='automatic'
        // `PageContainer` (not `bleed`) already applies the page gutter on
        // both sides — only the safe-area inset is this list's own to add, or
        // the grid opens with the gutter doubled.
        contentContainerStyle={{
          paddingTop: 16,
          paddingBottom: insets.bottom + 24,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
        data={libraries}
        numColumns={columns}
        renderItem={({ item, index }) => {
          const column = index % columns;
          return (
            <View
              style={{
                // A stated fraction of the row, not `flex: 1`: a last row of
                // one library in a three-column grid must sit in the first
                // column, not stretch itself across all three.
                width: `${100 / columns}%`,
                flexGrow: 0,
                flexShrink: 0,
                paddingLeft: column === 0 ? 0 : COLUMN_GAP / 2,
                paddingRight: column === columns - 1 ? 0 : COLUMN_GAP / 2,
              }}
            >
              <LibraryFlexCard library={item} />
            </View>
          );
        }}
        keyExtractor={(item) => item.Id || ""}
        ItemSeparatorComponent={() => <View style={{ height: ROW_GAP }} />}
      />
    </PageContainer>
  );
};

/**
 * `LibraryItemCard` takes an explicit pixel width, but a `flex: 1` grid cell
 * only knows its width once it has laid out — so this measures itself and
 * hands that width down, rather than the grid trying to precompute it from
 * the container/column math a second time.
 */
const LibraryFlexCard: React.FC<{ library: BaseItemDto }> = ({ library }) => {
  const [width, setWidth] = useState(0);

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && <LibraryItemCard library={library} width={width} />}
    </View>
  );
};
