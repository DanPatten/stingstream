import {
  getUserLibraryApi,
  getUserViewsApi,
} from "@jellyfin/sdk/lib/utils/api";
import { FlashList } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState } from "@/components/common/EmptyState";
import { PageContainer } from "@/components/common/PageContainer";
import { Loader } from "@/components/Loader";
import { LibraryItemCard } from "@/components/library/LibraryItemCard";
import { maxWidth } from "@/constants/theme";
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
  const { name: breakpointName, gutter } = useBreakpoint();
  const { width: windowWidth } = useWindowDimensions();

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

  // Widths in pixels, derived once, rather than percentages inside a cell
  // whose own width is the list's business: on Android a `width: "50%"` cell
  // inside FlashList's `numColumns` resolved against the *cell*, not the row,
  // and the cards came out a quarter of the size they should have been. This
  // is the same arithmetic `useCardGrid` does, for the same reason.
  // `PageContainer` (not `bleed`) has already taken the gutter off both sides.
  const listWidth =
    Math.min(windowWidth, maxWidth.media) -
    gutter * 2 -
    insets.left -
    insets.right;
  const cellWidth = listWidth / columns;
  const cardWidth = Math.floor(
    (listWidth - COLUMN_GAP * (columns - 1)) / columns,
  );

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
                // Stated, not `flex: 1`: a last row of one library in a
                // three-column grid must sit in the first column, not stretch
                // itself across all three.
                width: cellWidth,
                flexGrow: 0,
                flexShrink: 0,
                // A cell is wider than the card it holds, so each card is
                // nudged within its column to keep the gaps even.
                paddingLeft: (column * COLUMN_GAP) / columns,
              }}
            >
              <LibraryItemCard library={item} width={cardWidth} />
            </View>
          );
        }}
        keyExtractor={(item) => item.Id || ""}
        ItemSeparatorComponent={() => <View style={{ height: ROW_GAP }} />}
      />
    </PageContainer>
  );
};
