import type { Api } from "@jellyfin/sdk";
import type { BaseItemKind } from "@jellyfin/sdk/lib/generated-client";
import { getItemsApi } from "@jellyfin/sdk/lib/utils/api";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "i18next";
import { useAtom } from "jotai";
import { useCallback, useSyncExternalStore } from "react";
import { View } from "react-native";
import { EmptyState } from "@/components/common/EmptyState";
import useRouter from "@/hooks/useAppRouter";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { InfiniteScrollingCollectionList } from "./InfiniteScrollingCollectionList";

/**
 * The six row queries, by the key each row registers below.
 *
 * "Is this page empty" is read back out of the query cache rather than recorded as state while
 * fetching. The recorded version was wrong on every visit but the first: `setEmptyState` only ran
 * inside the fetcher, so a return visit — served from cache, fetcher never called — left every flag
 * at its mounted default while all six rows hid themselves through `hideIfEmpty`, and the screen
 * came up blank with no explanation (pass-03, found by WP1). The cache is the one source both the
 * rows and this banner already agree on.
 */
const FAVORITE_QUERY_KEYS = [
  ["home", "favorites", "series"],
  ["home", "favorites", "movies"],
  ["home", "favorites", "episodes"],
  ["home", "favorites", "videos"],
  ["home", "favorites", "boxsets"],
  ["home", "favorites", "playlists"],
] as const;

/** An infinite query's cached shape, as much of it as this file needs. */
type CachedPages = { pages?: unknown[][] } | undefined;

export const Favorites = () => {
  const router = useRouter();
  const [api] = useAtom(apiAtom);
  const [user] = useAtom(userAtom);
  const pageSize = 20;
  const queryClient = useQueryClient();

  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  // A kind counts as empty only once it has *loaded* and come back with nothing; a kind that has
  // not loaded is unknown, not empty, so the banner never flashes before the rows have answered.
  const readAllEmpty = useCallback(
    () =>
      FAVORITE_QUERY_KEYS.every((key) => {
        const data = queryClient.getQueryData<CachedPages>(key);
        if (!data?.pages) return false;
        return data.pages.every((page) => (page?.length ?? 0) === 0);
      }),
    [queryClient],
  );
  const areAllEmpty = useSyncExternalStore(
    subscribe,
    readAllEmpty,
    () => false,
  );

  const fetchFavoritesByType = useCallback(
    async (
      itemType: BaseItemKind,
      startIndex: number = 0,
      limit: number = 20,
    ) => {
      const response = await getItemsApi(api as Api).getItems({
        userId: user?.Id,
        sortBy: ["SeriesSortName", "SortName"],
        sortOrder: ["Ascending"],
        filters: ["IsFavorite"],
        recursive: true,
        fields: ["PrimaryImageAspectRatio"],
        collapseBoxSetItems: false,
        excludeLocationTypes: ["Virtual"],
        enableTotalRecordCount: false,
        startIndex: startIndex,
        limit: limit,
        includeItemTypes: [itemType],
      });
      return response.data.Items || [];
    },
    [api, user],
  );

  const fetchFavoriteSeries = useCallback(
    ({ pageParam }: { pageParam: number }) =>
      fetchFavoritesByType("Series", pageParam, pageSize),
    [fetchFavoritesByType, pageSize],
  );
  const fetchFavoriteMovies = useCallback(
    ({ pageParam }: { pageParam: number }) =>
      fetchFavoritesByType("Movie", pageParam, pageSize),
    [fetchFavoritesByType, pageSize],
  );
  const fetchFavoriteEpisodes = useCallback(
    ({ pageParam }: { pageParam: number }) =>
      fetchFavoritesByType("Episode", pageParam, pageSize),
    [fetchFavoritesByType, pageSize],
  );
  const fetchFavoriteVideos = useCallback(
    ({ pageParam }: { pageParam: number }) =>
      fetchFavoritesByType("Video", pageParam, pageSize),
    [fetchFavoritesByType, pageSize],
  );
  const fetchFavoriteBoxsets = useCallback(
    ({ pageParam }: { pageParam: number }) =>
      fetchFavoritesByType("BoxSet", pageParam, pageSize),
    [fetchFavoritesByType, pageSize],
  );
  const fetchFavoritePlaylists = useCallback(
    ({ pageParam }: { pageParam: number }) =>
      fetchFavoritesByType("Playlist", pageParam, pageSize),
    [fetchFavoritesByType, pageSize],
  );

  const handleSeeAllSeries = useCallback(() => {
    router.push({
      pathname: "/(auth)/(tabs)/(favorites)/see-all",
      params: { type: "Series", title: t("favorites.series") },
    } as any);
  }, [router]);

  const handleSeeAllMovies = useCallback(() => {
    router.push({
      pathname: "/(auth)/(tabs)/(favorites)/see-all",
      params: { type: "Movie", title: t("favorites.movies") },
    } as any);
  }, [router]);

  const handleSeeAllEpisodes = useCallback(() => {
    router.push({
      pathname: "/(auth)/(tabs)/(favorites)/see-all",
      params: { type: "Episode", title: t("favorites.episodes") },
    } as any);
  }, [router]);

  const handleSeeAllVideos = useCallback(() => {
    router.push({
      pathname: "/(auth)/(tabs)/(favorites)/see-all",
      params: { type: "Video", title: t("favorites.videos") },
    } as any);
  }, [router]);

  const handleSeeAllBoxsets = useCallback(() => {
    router.push({
      pathname: "/(auth)/(tabs)/(favorites)/see-all",
      params: { type: "BoxSet", title: t("favorites.boxsets") },
    } as any);
  }, [router]);

  const handleSeeAllPlaylists = useCallback(() => {
    router.push({
      pathname: "/(auth)/(tabs)/(favorites)/see-all",
      params: { type: "Playlist", title: t("favorites.playlists") },
    } as any);
  }, [router]);

  return (
    <View className='flex flex-co gap-y-4'>
      {/*
        `EmptyState`, not a hand-rolled column: this one drew its two lines with
        react-native's own `Text`, so on web it came out in the browser's system
        font while every other word on the screen was Inter (pass-03 F-58). The
        shared component is the design system's answer to "there is nothing
        here", tinted glyph included.
      */}
      {areAllEmpty && (
        <EmptyState
          icon='favorite'
          title={t("favorites.noDataTitle")}
          detail={t("favorites.noData")}
        />
      )}
      <InfiniteScrollingCollectionList
        queryFn={fetchFavoriteSeries}
        queryKey={["home", "favorites", "series"]}
        title={t("favorites.series")}
        hideIfEmpty
        pageSize={pageSize}
        onPressSeeAll={handleSeeAllSeries}
      />
      <InfiniteScrollingCollectionList
        queryFn={fetchFavoriteMovies}
        queryKey={["home", "favorites", "movies"]}
        title={t("favorites.movies")}
        hideIfEmpty
        orientation='vertical'
        pageSize={pageSize}
        onPressSeeAll={handleSeeAllMovies}
      />
      <InfiniteScrollingCollectionList
        queryFn={fetchFavoriteEpisodes}
        queryKey={["home", "favorites", "episodes"]}
        title={t("favorites.episodes")}
        hideIfEmpty
        pageSize={pageSize}
        onPressSeeAll={handleSeeAllEpisodes}
      />
      <InfiniteScrollingCollectionList
        queryFn={fetchFavoriteVideos}
        queryKey={["home", "favorites", "videos"]}
        title={t("favorites.videos")}
        hideIfEmpty
        pageSize={pageSize}
        onPressSeeAll={handleSeeAllVideos}
      />
      <InfiniteScrollingCollectionList
        queryFn={fetchFavoriteBoxsets}
        queryKey={["home", "favorites", "boxsets"]}
        title={t("favorites.boxsets")}
        hideIfEmpty
        pageSize={pageSize}
        onPressSeeAll={handleSeeAllBoxsets}
      />
      <InfiniteScrollingCollectionList
        queryFn={fetchFavoritePlaylists}
        queryKey={["home", "favorites", "playlists"]}
        title={t("favorites.playlists")}
        hideIfEmpty
        pageSize={pageSize}
        onPressSeeAll={handleSeeAllPlaylists}
      />
    </View>
  );
};
