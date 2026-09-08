import type {
  BaseItemDto,
  BaseItemKind,
} from "@jellyfin/sdk/lib/generated-client/models";
import { ItemFields } from "@jellyfin/sdk/lib/generated-client/models";
import { getItemsApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { useLocalSearchParams, useSegments } from "expo-router";
import { useAtom } from "jotai";
import { orderBy, uniqBy } from "lodash";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CardRow } from "@/components/cards/CardRow";
import { EmptyState } from "@/components/common/EmptyState";
import { Icon } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { PageContainer } from "@/components/common/PageContainer";
import { Pill } from "@/components/common/Pill";
import { type Segment, Tabs } from "@/components/common/Tabs";
import { Text } from "@/components/common/Text";
import { getItemNavigation } from "@/components/common/TouchableItemRouter";
import {
  JellyseerrSearchSort,
  JellyserrIndexPage,
} from "@/components/jellyseerr/JellyseerrIndexPage";
import { DiscoverFilters } from "@/components/search/DiscoverFilters";
import { SearchPeopleRow } from "@/components/search/SearchPeopleRow";
import { SearchRequestSection } from "@/components/search/SearchRequestSection";
import { SearchSectionTitle } from "@/components/search/SearchSectionTitle";
import { TVSearchPage } from "@/components/search/TVSearchPage";
import { RequestSheet } from "@/components/stingstream/requests/RequestSheet";
import { tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useCatalogueSearch } from "@/hooks/useCatalogueSearch";
import { useJellyseerr } from "@/hooks/useJellyseerr";
import { useTVItemActionModal } from "@/hooks/useTVItemActionModal";
import {
  libraryMatchKeys,
  type RequestSearchResult,
  toRequestCard,
} from "@/lib/stingstream/requestsApi";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import { getIntegrationHeaders } from "@/utils/customHeaders";
import { MediaType } from "@/utils/jellyseerr/server/constants/media";
import type {
  MovieResult,
  PersonResult,
  TvResult,
} from "@/utils/jellyseerr/server/models/Search";
import {
  addRecentSearch,
  clearRecentSearches,
  getRecentSearches,
} from "@/utils/search/recentSearches";
import { createStreamystatsApi } from "@/utils/streamystats";

type SearchType = "Library" | "Discover";

/** Drives the live results — fast enough that typing still feels immediate. */
const RESULTS_DEBOUNCE_MS = 250;
/**
 * A second, longer debounce purely for "recent searches": long enough after
 * the results settle that a search the user paused on gets recorded, not
 * every intermediate substring of what they typed on the way there.
 */
const RECENT_SEARCH_SETTLE_MS = 600;
/** One automatic retry per query; the EmptyState's own Retry button covers the rest. */
const LIBRARY_QUERY_RETRY = 1;

const EXAMPLE_SEARCH_KEYS = [
  "example_search_1",
  "example_search_2",
  "example_search_3",
  "example_search_4",
  "example_search_5",
  "example_search_6",
] as const;

export default function SearchPage() {
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isWebWide, gutter } = useBreakpoint();
  const { showItemActions } = useTVItemActionModal();
  const segments = useSegments();
  const from = (segments as string[])[2] || "(search)";

  const [user] = useAtom(userAtom);
  const [api] = useAtom(apiAtom);
  const { t } = useTranslation();

  const searchFilterId = useId();
  const orderFilterId = useId();

  const { q } = params as { q: string };

  const [searchType, setSearchType] = useState<SearchType>("Library");
  const [search, setSearch] = useState(q ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(
    isWebWide ? (q ?? "") : "",
  );
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    setRecentSearches(getRecentSearches());
  }, []);

  const { settings } = useSettings();
  const { jellyseerrApi } = useJellyseerr();
  const showDiscoverTab = Boolean(jellyseerrApi);

  const [jellyseerrOrderBy, setJellyseerrOrderBy] =
    useState<JellyseerrSearchSort>(
      JellyseerrSearchSort[
        JellyseerrSearchSort.DEFAULT
      ] as unknown as JellyseerrSearchSort,
    );
  const [jellyseerrSortOrder, setJellyseerrSortOrder] = useState<
    "asc" | "desc"
  >("desc");

  const searchEngine = useMemo(() => {
    return settings?.searchEngine || "Jellyfin";
  }, [settings]);

  // Web wide: no input of this screen's own — the TopBar's field already owns
  // `q`, debounced on its own end, so the query follows it directly. Compact:
  // a deep link or an external navigation can still hand this screen a `q`;
  // pick it up into the local field the user actually types into.
  useEffect(() => {
    if (!isWebWide && q && q.length > 0) setSearch(q);
  }, [q, isWebWide]);

  useEffect(() => {
    if (isWebWide) {
      setDebouncedSearch(q ?? "");
      return;
    }
    const timeout = setTimeout(
      () => setDebouncedSearch(search),
      RESULTS_DEBOUNCE_MS,
    );
    return () => clearTimeout(timeout);
  }, [isWebWide, q, search]);

  // Records a *settled* search, not every keystroke on the way to it.
  useEffect(() => {
    if (!debouncedSearch) return;
    const timeout = setTimeout(() => {
      setRecentSearches(addRecentSearch(debouncedSearch));
    }, RECENT_SEARCH_SETTLE_MS);
    return () => clearTimeout(timeout);
  }, [debouncedSearch]);

  /** Sets the active query, whichever platform owns the field that drives it. */
  const fillQuery = useCallback(
    (value: string) => {
      if (isWebWide) {
        router.setParams({ q: value });
      } else {
        setSearch(value);
      }
    },
    [isWebWide, router],
  );

  const handleClearRecentSearches = useCallback(() => {
    setRecentSearches(clearRecentSearches());
  }, []);

  const searchFn = useCallback(
    async ({
      types,
      query,
      signal,
    }: {
      types: BaseItemKind[];
      query: string;
      signal?: AbortSignal;
    }): Promise<BaseItemDto[]> => {
      if (!api || !query) {
        return [];
      }

      if (searchEngine === "Jellyfin") {
        const searchApi = await getItemsApi(api).getItems(
          {
            searchTerm: query,
            limit: 10,
            includeItemTypes: types,
            recursive: true,
            userId: user?.Id,
            // What the catalogue half of this screen dedupes against. Without
            // it Jellyfin sends no `ProviderIds` at all, and every film the
            // server already holds would also be offered as one to request.
            fields: [ItemFields.ProviderIds],
          },
          { signal },
        );

        return (searchApi.data.Items as BaseItemDto[]) || [];
      }

      if (searchEngine === "Streamystats") {
        if (!settings?.streamyStatsServerUrl || !api.accessToken) {
          return [];
        }

        const streamyStatsApi = createStreamystatsApi({
          serverUrl: settings.streamyStatsServerUrl,
          jellyfinToken: api.accessToken,
        });

        const typeMap: Record<BaseItemKind, string> = {
          Movie: "movies",
          Series: "series",
          Episode: "episodes",
          Person: "actors",
          BoxSet: "movies",
          Audio: "audio",
        } as Record<BaseItemKind, string>;

        const searchTypeKey = types.length === 1 ? typeMap[types[0]] : "media";
        const response = await streamyStatsApi.searchIds(
          query,
          searchTypeKey as
            | "movies"
            | "series"
            | "episodes"
            | "actors"
            | "media",
          10,
          signal,
        );

        const allIds: string[] = [
          ...(response.data.movies || []),
          ...(response.data.series || []),
          ...(response.data.episodes || []),
          ...(response.data.actors || []),
          ...(response.data.audio || []),
        ];

        if (!allIds.length) {
          return [];
        }

        const itemsResponse = await getItemsApi(api).getItems(
          {
            ids: allIds,
            enableImageTypes: ["Primary", "Backdrop", "Thumb"],
            fields: [ItemFields.ProviderIds],
          },
          { signal },
        );

        return (itemsResponse.data.Items as BaseItemDto[]) || [];
      }

      // Marlin search
      if (!settings?.marlinServerUrl) {
        return [];
      }

      const url = `${settings.marlinServerUrl}/search?q=${encodeURIComponent(query)}&includeItemTypes=${types
        .map((type) => encodeURIComponent(type))
        .join("&includeItemTypes=")}`;

      const response1 = await axios.get(url, {
        signal,
        headers: getIntegrationHeaders("marlin"),
      });

      const ids = response1.data.ids;

      if (!ids?.length) {
        return [];
      }

      const response2 = await getItemsApi(api).getItems(
        {
          ids,
          enableImageTypes: ["Primary", "Backdrop", "Thumb"],
          fields: [ItemFields.ProviderIds],
        },
        { signal },
      );

      return (response2.data.Items as BaseItemDto[]) || [];
    },
    [api, searchEngine, settings, user?.Id],
  );

  // Separate search function for music types - always uses Jellyfin since Streamystats doesn't support music
  const jellyfinSearchFn = useCallback(
    async ({
      types,
      query,
      signal,
    }: {
      types: BaseItemKind[];
      query: string;
      signal?: AbortSignal;
    }): Promise<BaseItemDto[]> => {
      if (!api || !query) {
        return [];
      }

      const searchApi = await getItemsApi(api).getItems(
        {
          searchTerm: query,
          limit: 10,
          includeItemTypes: types,
          recursive: true,
          userId: user?.Id,
          fields: [ItemFields.ProviderIds],
        },
        { signal },
      );

      return (searchApi.data.Items as BaseItemDto[]) || [];
    },
    [api, user?.Id],
  );

  const libraryEnabled = searchType === "Library" && debouncedSearch.length > 0;

  const moviesQuery = useQuery({
    queryKey: ["search", "movies", debouncedSearch],
    queryFn: ({ signal }) =>
      searchFn({ query: debouncedSearch, types: ["Movie"], signal }),
    enabled: libraryEnabled,
    retry: LIBRARY_QUERY_RETRY,
  });

  const seriesQuery = useQuery({
    queryKey: ["search", "series", debouncedSearch],
    queryFn: ({ signal }) =>
      searchFn({ query: debouncedSearch, types: ["Series"], signal }),
    enabled: libraryEnabled,
    retry: LIBRARY_QUERY_RETRY,
  });

  const episodesQuery = useQuery({
    queryKey: ["search", "episodes", debouncedSearch],
    queryFn: ({ signal }) =>
      searchFn({ query: debouncedSearch, types: ["Episode"], signal }),
    enabled: libraryEnabled,
    retry: LIBRARY_QUERY_RETRY,
  });

  const collectionsQuery = useQuery({
    queryKey: ["search", "collections", debouncedSearch],
    queryFn: ({ signal }) =>
      searchFn({ query: debouncedSearch, types: ["BoxSet"], signal }),
    enabled: libraryEnabled,
    retry: LIBRARY_QUERY_RETRY,
  });

  const actorsQuery = useQuery({
    queryKey: ["search", "actors", debouncedSearch],
    queryFn: ({ signal }) =>
      searchFn({ query: debouncedSearch, types: ["Person"], signal }),
    enabled: libraryEnabled,
    retry: LIBRARY_QUERY_RETRY,
  });

  // Music search queries - always use Jellyfin since Streamystats doesn't support music
  const artistsQuery = useQuery({
    queryKey: ["search", "artists", debouncedSearch],
    queryFn: ({ signal }) =>
      jellyfinSearchFn({
        query: debouncedSearch,
        types: ["MusicArtist"],
        signal,
      }),
    enabled: libraryEnabled,
    retry: LIBRARY_QUERY_RETRY,
  });

  const albumsQuery = useQuery({
    queryKey: ["search", "albums", debouncedSearch],
    queryFn: ({ signal }) =>
      jellyfinSearchFn({
        query: debouncedSearch,
        types: ["MusicAlbum"],
        signal,
      }),
    enabled: libraryEnabled,
    retry: LIBRARY_QUERY_RETRY,
  });

  const songsQuery = useQuery({
    queryKey: ["search", "songs", debouncedSearch],
    queryFn: ({ signal }) =>
      jellyfinSearchFn({ query: debouncedSearch, types: ["Audio"], signal }),
    enabled: libraryEnabled,
    retry: LIBRARY_QUERY_RETRY,
  });

  const playlistsQuery = useQuery({
    queryKey: ["search", "playlists", debouncedSearch],
    queryFn: ({ signal }) =>
      jellyfinSearchFn({ query: debouncedSearch, types: ["Playlist"], signal }),
    enabled: libraryEnabled,
    retry: LIBRARY_QUERY_RETRY,
  });

  const libraryQueries = [
    moviesQuery,
    seriesQuery,
    episodesQuery,
    collectionsQuery,
    actorsQuery,
    artistsQuery,
    albumsQuery,
    songsQuery,
    playlistsQuery,
  ];

  const libraryLoading = libraryQueries.some((query) => query.isFetching);
  const failedLibraryQueries = libraryQueries.filter((query) => query.error);
  const hasLibraryError = failedLibraryQueries.length > 0;
  const noLibraryResults = !libraryQueries.some(
    (query) => (query.data?.length ?? 0) > 0,
  );

  const retryFailedLibraryQueries = useCallback(() => {
    for (const query of failedLibraryQueries) void query.refetch();
  }, [failedLibraryQueries]);

  // --- the other half of the same search ---------------------------------
  //
  // One box, two catalogues: Jellyfin for what this server holds, the node's
  // own requests search for what it does not. Only films and series go into
  // the dedupe keys — an episode's title and ids are the episode's own and
  // could neither match nor usefully exclude a catalogue result.
  const libraryKeys = useMemo(
    () =>
      libraryMatchKeys([
        ...(moviesQuery.data ?? []),
        ...(seriesQuery.data ?? []),
      ]),
    [moviesQuery.data, seriesQuery.data],
  );
  // The television has its own search screen and its own way of asking (see
  // `TVSearchPage`), so it is handed an empty term and never runs either call.
  const catalogue = useCatalogueSearch(
    Platform.isTV ? "" : debouncedSearch,
    libraryKeys,
  );

  /** The result whose request sheet is open, for either section. */
  const [picking, setPicking] = useState<RequestSearchResult | null>(null);

  const memberCards = useMemo(
    () => catalogue.heldByMember.map(toRequestCard),
    [catalogue.heldByMember],
  );
  const memberByCardId = useMemo(
    () =>
      new Map(
        catalogue.heldByMember.map((result) => [
          toRequestCard(result).id,
          result,
        ]),
      ),
    [catalogue.heldByMember],
  );
  const pickMemberCard = useCallback(
    (id: string) => {
      const result = memberByCardId.get(id);
      if (result) setPicking(result);
    },
    [memberByCardId],
  );

  // TV item press handler
  const handleItemPress = useCallback(
    (item: BaseItemDto) => {
      const navigation = getItemNavigation(item, from);
      router.push(navigation as any);
    },
    [from, router],
  );

  // Jellyseerr search for TV
  const { data: jellyseerrTVResults, isFetching: jellyseerrTVLoading } =
    useQuery({
      queryKey: ["search", "jellyseerr", "tv", debouncedSearch],
      queryFn: async () => {
        const searchParams = {
          query: new URLSearchParams(debouncedSearch || "").toString(),
        };
        return await Promise.all([
          jellyseerrApi?.search({ ...searchParams, page: 1 }),
          jellyseerrApi?.search({ ...searchParams, page: 2 }),
          jellyseerrApi?.search({ ...searchParams, page: 3 }),
          jellyseerrApi?.search({ ...searchParams, page: 4 }),
        ]).then((all) =>
          uniqBy(
            all.flatMap((v) => v?.results || []),
            "id",
          ),
        );
      },
      enabled:
        Platform.isTV &&
        !!jellyseerrApi &&
        searchType === "Discover" &&
        debouncedSearch.length > 0,
    });

  // Process Jellyseerr results for TV
  const jellyseerrMovieResults = useMemo(
    () =>
      orderBy(
        jellyseerrTVResults?.filter(
          (r) => r.mediaType === MediaType.MOVIE,
        ) as MovieResult[],
        [(m) => m?.title?.toLowerCase() === debouncedSearch.toLowerCase()],
        "desc",
      ),
    [jellyseerrTVResults, debouncedSearch],
  );

  const jellyseerrTvResults = useMemo(
    () =>
      orderBy(
        jellyseerrTVResults?.filter(
          (r) => r.mediaType === MediaType.TV,
        ) as TvResult[],
        [(tv) => tv?.name?.toLowerCase() === debouncedSearch.toLowerCase()],
        "desc",
      ),
    [jellyseerrTVResults, debouncedSearch],
  );

  const jellyseerrPersonResults = useMemo(
    () =>
      orderBy(
        jellyseerrTVResults?.filter(
          (r) => r.mediaType === "person",
        ) as PersonResult[],
        [(p) => p?.name?.toLowerCase() === debouncedSearch.toLowerCase()],
        "desc",
      ),
    [jellyseerrTVResults, debouncedSearch],
  );

  const jellyseerrTVNoResults = useMemo(() => {
    return (
      !jellyseerrMovieResults?.length &&
      !jellyseerrTvResults?.length &&
      !jellyseerrPersonResults?.length
    );
  }, [jellyseerrMovieResults, jellyseerrTvResults, jellyseerrPersonResults]);

  // TV Jellyseerr press handlers
  const handleJellyseerrMoviePress = useCallback(
    (item: MovieResult) => {
      router.push({
        pathname: "/(auth)/(tabs)/(search)/jellyseerr/page",
        params: {
          mediaTitle: item.title,
          releaseYear: String(new Date(item.releaseDate || "").getFullYear()),
          canRequest: "true",
          posterSrc: jellyseerrApi?.imageProxy(item.posterPath) || "",
          mediaType: MediaType.MOVIE,
          id: String(item.id),
          backdropPath: item.backdropPath || "",
          overview: item.overview || "",
        },
      });
    },
    [router, jellyseerrApi],
  );

  const handleJellyseerrTvPress = useCallback(
    (item: TvResult) => {
      router.push({
        pathname: "/(auth)/(tabs)/(search)/jellyseerr/page",
        params: {
          mediaTitle: item.name,
          releaseYear: String(new Date(item.firstAirDate || "").getFullYear()),
          canRequest: "true",
          posterSrc: jellyseerrApi?.imageProxy(item.posterPath) || "",
          mediaType: MediaType.TV,
          id: String(item.id),
          backdropPath: item.backdropPath || "",
          overview: item.overview || "",
        },
      });
    },
    [router, jellyseerrApi],
  );

  const handleJellyseerrPersonPress = useCallback(
    (item: PersonResult) => {
      router.push(`/(auth)/jellyseerr/person/${item.id}` as any);
    },
    [router],
  );

  // Render TV search page
  if (Platform.isTV) {
    return (
      <TVSearchPage
        search={search}
        setSearch={setSearch}
        debouncedSearch={debouncedSearch}
        movies={moviesQuery.data}
        series={seriesQuery.data}
        episodes={episodesQuery.data}
        collections={collectionsQuery.data}
        actors={actorsQuery.data}
        artists={artistsQuery.data}
        albums={albumsQuery.data}
        songs={songsQuery.data}
        playlists={playlistsQuery.data}
        loading={libraryLoading}
        noResults={noLibraryResults}
        onItemPress={handleItemPress}
        onItemLongPress={showItemActions}
        searchType={searchType}
        setSearchType={setSearchType}
        showDiscover={!!jellyseerrApi}
        jellyseerrMovies={jellyseerrMovieResults}
        jellyseerrTv={jellyseerrTvResults}
        jellyseerrPersons={jellyseerrPersonResults}
        jellyseerrLoading={jellyseerrTVLoading}
        jellyseerrNoResults={jellyseerrTVNoResults}
        onJellyseerrMoviePress={handleJellyseerrMoviePress}
        onJellyseerrTvPress={handleJellyseerrTvPress}
        onJellyseerrPersonPress={handleJellyseerrPersonPress}
      />
    );
  }

  const tabSegments: Segment[] = [
    { key: "Library", label: t("search.library") },
    { key: "Discover", label: t("search.discover") },
  ];

  // Whether the catalogue half has anything to say. It draws nothing at all
  // otherwise: a server with no requests feature, a node whose downloaders are
  // not configured, and a search that genuinely matched nothing new all arrive
  // here empty, and none of them is worth a box on a screen that has just
  // shown the user what it *did* find.
  const showRequestSection =
    !catalogue.unavailable &&
    (catalogue.loading || catalogue.requestable.length > 0);
  const showMemberRow = memberCards.length > 0;
  // Every row inside it hides itself when it has nothing, so without this the
  // whole section would collapse to a heading with a void under it — which is
  // exactly what a search matching only titles this server does not have would
  // produce.
  const showLibrarySection =
    libraryLoading || !noLibraryResults || showMemberRow;
  // The library rows carry their own headings ("Movies", "Series"), so the
  // section label above them only earns its space once there is a second
  // section to tell it apart from.
  const showSectionTitles = showRequestSection || showMemberRow;
  const nothingAnywhere =
    noLibraryResults && !showMemberRow && catalogue.requestable.length === 0;

  const libraryContent =
    debouncedSearch.length === 0 ? (
      <View testID='search-empty'>
        <EmptyState
          icon='search'
          title={t("search.empty_title")}
          detail={t("search.empty_detail")}
        />
        <View style={{ paddingHorizontal: gutter, marginTop: -20 }}>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 8,
            }}
          >
            {EXAMPLE_SEARCH_KEYS.map((key) => {
              const label = t(`search.${key}`);
              return (
                <View testID='search-example-chip' key={key}>
                  <Pill
                    label={label}
                    onPress={() => fillQuery(label)}
                    style={{ minHeight: tokens.control.minTouchTarget }}
                  />
                </View>
              );
            })}
          </View>

          {recentSearches.length > 0 ? (
            <View style={{ marginTop: 28 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 10,
                }}
              >
                <Text variant='caption' tone='secondary' weight='semibold'>
                  {t("search.recent_searches")}
                </Text>
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel={t("search.clear_recent_searches")}
                  onPress={handleClearRecentSearches}
                >
                  <Text variant='caption' tone='accent' weight='semibold'>
                    {t("search.clear_recent_searches")}
                  </Text>
                </Pressable>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {recentSearches.map((recent) => (
                  <View testID='search-recent-chip' key={recent}>
                    <Pill
                      label={recent}
                      icon='search'
                      onPress={() => fillQuery(recent)}
                      style={{ minHeight: tokens.control.minTouchTarget }}
                    />
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </View>
    ) : !libraryLoading &&
      !hasLibraryError &&
      !catalogue.loading &&
      nothingAnywhere ? (
      <View testID='search-empty'>
        <EmptyState
          icon='search'
          title={`${t("search.no_results_found_for")} "${debouncedSearch}"`}
          // No "ask for it" button any more: the section above this one *is*
          // the asking, so an empty state that offers to take you elsewhere to
          // do it would be sending you back to a screen that no longer has it.
          // Without requests on this server there is nothing to offer at all,
          // and saying so plainly beats a button that leads to a 503.
          detail={
            catalogue.unavailable
              ? t("search.no_results_not_in_library")
              : t("search.no_results_detail")
          }
        />
      </View>
    ) : (
      <View testID='search-results'>
        {hasLibraryError ? (
          <View style={{ paddingHorizontal: gutter, marginBottom: 8 }}>
            <EmptyState
              icon='warning'
              title={t("common.something_went_wrong")}
              detail={t("search.error_detail")}
              action={{
                label: t("common.retry"),
                icon: "refresh",
                onPress: retryFailedLibraryQueries,
              }}
            />
          </View>
        ) : null}
        {showLibrarySection ? (
          <View testID='search-library-section'>
            {showSectionTitles ? (
              <SearchSectionTitle title={t("search.in_your_library")} />
            ) : null}
            <CardRow
              title={t("search.movies")}
              items={moviesQuery.data}
              kind='portrait'
              loading={moviesQuery.isFetching}
              hideIfEmpty
            />
            <CardRow
              title={t("search.series")}
              items={seriesQuery.data}
              kind='portrait'
              loading={seriesQuery.isFetching}
              hideIfEmpty
            />
            <CardRow
              title={t("search.episodes")}
              items={episodesQuery.data}
              kind='wide'
              loading={episodesQuery.isFetching}
              hideIfEmpty
            />
            <CardRow
              title={t("search.collections")}
              items={collectionsQuery.data}
              kind='portrait'
              loading={collectionsQuery.isFetching}
              hideIfEmpty
            />
            <SearchPeopleRow
              title={t("search.actors")}
              people={actorsQuery.data}
              loading={actorsQuery.isFetching}
              from={from}
            />
            <CardRow
              title={t("search.artists")}
              items={artistsQuery.data}
              kind='portrait'
              loading={artistsQuery.isFetching}
              hideIfEmpty
            />
            <CardRow
              title={t("search.albums")}
              items={albumsQuery.data}
              kind='portrait'
              loading={albumsQuery.isFetching}
              hideIfEmpty
            />
            <CardRow
              title={t("search.songs")}
              items={songsQuery.data}
              kind='portrait'
              loading={songsQuery.isFetching}
              hideIfEmpty
            />
            <CardRow
              title={t("search.playlists")}
              items={playlistsQuery.data}
              kind='portrait'
              loading={playlistsQuery.isFetching}
              hideIfEmpty
            />
            {/*
              Not in *this* server's library, but somebody in the group has
              it — which makes it something to watch, not something to ask
              for. It belongs on this side of the line under a heading that
              says where it is coming from; pressing one opens the same sheet,
              which names the holder and offers no download.
            */}
            <CardRow
              title={t("search.available_from_member")}
              cards={memberCards}
              kind='portrait'
              onPressId={pickMemberCard}
              hideIfEmpty
            />
          </View>
        ) : null}

        {showRequestSection ? (
          <SearchRequestSection
            results={catalogue.requestable}
            loading={catalogue.loading}
            onPressResult={setPicking}
          />
        ) : null}
      </View>
    );

  const discoverContent = (
    <JellyserrIndexPage
      searchQuery={debouncedSearch}
      sortType={jellyseerrOrderBy}
      order={jellyseerrSortOrder}
    />
  );

  return (
    <ScrollView
      keyboardDismissMode='on-drag'
      contentInsetAdjustmentBehavior='automatic'
      stickyHeaderIndices={!isWebWide ? [0] : undefined}
      contentContainerStyle={{
        paddingLeft: insets.left,
        paddingRight: insets.right,
        paddingBottom: 60,
      }}
    >
      {!isWebWide ? (
        <View
          style={{
            backgroundColor: tokens.color.bg["0"],
            paddingHorizontal: gutter,
            paddingVertical: 10,
          }}
        >
          <View style={{ position: "relative", justifyContent: "center" }}>
            <Input
              testID='search-input'
              icon='search'
              value={search}
              onChangeText={setSearch}
              onSubmitEditing={() => Keyboard.dismiss()}
              returnKeyType='search'
              placeholder={t("search.search")}
              accessibilityLabel={t("search.search")}
              autoCorrect={false}
              style={search.length > 0 ? { paddingRight: 36 } : undefined}
            />
            {search.length > 0 ? (
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={t("search.clear_search")}
                onPress={() => setSearch("")}
                style={{
                  position: "absolute",
                  right: 6,
                  height: "100%",
                  width: 32,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name='close' size={16} tone='tertiary' />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      <PageContainer
        width='media'
        bleed
        style={{ paddingTop: isWebWide ? 20 : 12 }}
      >
        {showDiscoverTab ? (
          <View
            testID='search-tabs'
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <Tabs
                segments={tabSegments}
                value={searchType}
                onChange={(key) => setSearchType(key as SearchType)}
              />
            </View>
            {searchType === "Discover" && debouncedSearch.length > 0 ? (
              <View style={{ paddingRight: gutter }}>
                <DiscoverFilters
                  searchFilterId={searchFilterId}
                  orderFilterId={orderFilterId}
                  jellyseerrOrderBy={jellyseerrOrderBy}
                  setJellyseerrOrderBy={setJellyseerrOrderBy}
                  jellyseerrSortOrder={jellyseerrSortOrder}
                  setJellyseerrSortOrder={setJellyseerrSortOrder}
                  t={t}
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {searchType === "Discover" && showDiscoverTab
          ? discoverContent
          : libraryContent}

        {/*
          One sheet for both sections, mounted here rather than inside either
          of them: it renders nothing until something is picked, and a copy per
          section would mean two `Dialog`s racing to be the one on screen.
        */}
        <RequestSheet result={picking} onClose={() => setPicking(null)} />
      </PageContainer>
    </ScrollView>
  );
}
