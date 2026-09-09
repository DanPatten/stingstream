import type {
  BaseItemDto,
  BaseItemDtoQueryResult,
  BaseItemKind,
} from "@jellyfin/sdk/lib/generated-client/models";
import {
  getItemsApi,
  getSuggestionsApi,
  getTvShowsApi,
  getUserLibraryApi,
  getUserViewsApi,
} from "@jellyfin/sdk/lib/utils/api";
import { type QueryFunction, useQuery } from "@tanstack/react-query";
import { useSegments } from "expo-router";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/Button";
import { CardRowSkeleton } from "@/components/cards/CardRowSkeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { PageContainer } from "@/components/common/PageContainer";
import { Skeleton } from "@/components/common/Skeleton";
import { HomeHeroCarousel } from "@/components/home/HomeHeroCarousel";
import { InfiniteScrollingCollectionList } from "@/components/home/InfiniteScrollingCollectionList";
import { StreamystatsPromotedWatchlists } from "@/components/home/StreamystatsPromotedWatchlists";
import { StreamystatsRecommendations } from "@/components/home/StreamystatsRecommendations";
import { MediaListSection } from "@/components/medialists/MediaListSection";
import { useIsStingStreamAdmin } from "@/components/stingstream/shared/RequiresAdmin";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useRefreshLibraryOnFocus } from "@/hooks/useRefreshLibraryOnFocus";
import { useInvalidatePlaybackProgressCache } from "@/hooks/useRevalidatePlaybackProgressCache";
import { useDownload } from "@/providers/DownloadProvider";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { SortByOption, SortOrderOption } from "@/utils/atoms/filters";
import { useSettings } from "@/utils/atoms/settings";
import { eventBus } from "@/utils/eventBus";

// Conditionally load TV version
const HomeTV = Platform.isTV ? require("./Home.tv").Home : null;

type InfiniteScrollingCollectionListSection = {
  type: "InfiniteScrollingCollectionList";
  title?: string;
  queryKey: (string | undefined | null)[];
  queryFn: QueryFunction<BaseItemDto[], any, number>;
  orientation?: "horizontal" | "vertical";
  pageSize?: number;
  priority?: 1 | 2; // 1 = high priority (loads first), 2 = low priority
  parentId?: string; // Library ID for "See All" navigation
  /**
   * How the library should be sorted when "See all" opens it, so the screen
   * the viewer lands on starts with the same items the row was showing.
   */
  seeAllSort?: { sortBy: SortByOption; sortOrder: SortOrderOption };
};

type MediaListSectionType = {
  type: "MediaListSection";
  queryKey: (string | undefined)[];
  queryFn: QueryFunction<BaseItemDto>;
  priority?: 1 | 2;
};

type Section = InfiniteScrollingCollectionListSection | MediaListSectionType;

const HomeMobile = () => {
  const router = useRouter();
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const { settings, refreshStreamyfinPluginSettings } = useSettings();
  const scrollRef = useRef<ScrollView>(null);
  const { cleanCacheDirectory } = useDownload();
  const prevIsConnected = useRef<boolean | null>(false);
  const {
    isConnected,
    serverConnected,
    loading: retryLoading,
    retryCheck,
  } = useNetworkStatus();
  const invalidateCache = useInvalidatePlaybackProgressCache();
  const [loadedSections, setLoadedSections] = useState<Set<string>>(new Set());

  // Fallback refresh for newly added content when returning to the home screen
  // (primary path is the LibraryChanged WebSocket event).
  useRefreshLibraryOnFocus();

  // No sheet on first launch. Signing in for the first time used to be followed a second later
  // by a modal explaining the app — Dan's instruction for v0.2.0 was "no setup step", and that
  // counts. `IntroSheet` is still reachable on purpose, from Settings.

  useEffect(() => {
    if (isConnected && !prevIsConnected.current) {
      invalidateCache();
    }
    prevIsConnected.current = isConnected;
  }, [isConnected, invalidateCache]);

  // The downloads shortcut this screen used to install into its own
  // `headerLeft` now lives in `(home)/_layout.tsx`'s header button group. The
  // leading edge of a phone header is the app mark's (pass-01 F-13), and a
  // screen reaching up through `navigation.setOptions` to claim it was always
  // the wrong way round.

  useEffect(() => {
    cleanCacheDirectory().catch((_e) =>
      console.error("Something went wrong cleaning cache directory"),
    );
  }, []);

  const segments = useSegments();
  useEffect(() => {
    const unsubscribe = eventBus.on("scrollToTop", () => {
      if ((segments as string[])[2] === "(home)")
        scrollRef.current?.scrollTo({
          y: Platform.isTV ? -152 : -100,
          animated: true,
        });
    });

    return () => {
      unsubscribe();
    };
  }, [segments]);

  const {
    data,
    isError: e1,
    isLoading: l1,
  } = useQuery({
    queryKey: ["home", "userViews", user?.Id],
    queryFn: async () => {
      if (!api || !user?.Id) {
        return null;
      }

      const response = await getUserViewsApi(api).getUserViews({
        userId: user.Id,
      });

      return response.data.Items || null;
    },
    enabled: !!api && !!user?.Id,
    staleTime: 60 * 1000,
  });

  const userViews = useMemo(
    () => data?.filter((l) => !settings?.hiddenLibraries?.includes(l.Id!)),
    [data, settings?.hiddenLibraries],
  );

  const isAdmin = useIsStingStreamAdmin();

  /**
   * Does this server hold anything at all?
   *
   * Every row on this page renders nothing when its own query comes back empty, so a server with
   * libraries and no files in them produced a **completely blank page** — Dan: *"skeleton state
   * doesnt make sense when theres no content"*. Neither the skeleton nor the rows were wrong on
   * their own; what was missing was anybody asking the question the page turns on.
   *
   * One count rather than watching the rows: a row being empty is not the same as the library
   * being empty (Continue watching is empty for everybody on day one), and `TotalRecordCount` with
   * `limit: 1` is a cheap, unambiguous answer to the question actually being asked.
   */
  const { data: itemCount } = useQuery({
    queryKey: ["home", "itemCount", user?.Id],
    queryFn: async () => {
      const response = await getItemsApi(api!).getItems({
        userId: user?.Id,
        recursive: true,
        includeItemTypes: ["Movie", "Series"],
        limit: 1,
      });
      return response.data.TotalRecordCount ?? 0;
    },
    enabled: !!api && !!user?.Id,
    staleTime: 60 * 1000,
  });

  const collections = useMemo(() => {
    const allow = ["movies", "tvshows"];
    return (
      userViews?.filter(
        (c) => c.CollectionType && allow.includes(c.CollectionType),
      ) || []
    );
  }, [userViews]);

  /** Where "See all" on the suggested-films row goes, when there is one. */
  const movieLibraryId = useMemo(
    () => collections.find((c) => c.CollectionType === "movies")?.Id,
    [collections],
  );

  const refetch = async () => {
    setLoading(true);
    setLoadedSections(new Set());
    await refreshStreamyfinPluginSettings();
    await invalidateCache();
    setLoading(false);
  };

  const createCollectionConfig = useCallback(
    (
      title: string,
      queryKey: string[],
      includeItemTypes: BaseItemKind[],
      parentId: string | undefined,
      pageSize: number = 10,
    ): InfiniteScrollingCollectionListSection => ({
      title,
      queryKey,
      queryFn: async ({ pageParam = 0 }) => {
        if (!api) return [];
        // Use getItems (not getLatestMedia) so we get item-level results
        // filtered by type from a specific library. getLatestMedia is
        // episode-oriented and groups results, which drops Series when
        // combined with a parentId + includeItemTypes filter.
        //
        // The specific reason for this is jellyfin 12.0 returns episodes, seasons, or shows,
        // but we only handle shows in our recently added in [shows] section. So we need to filter by type at the item level.
        //
        // For Series we sort by DateLastContentAdded so shows bubble up when
        // a new episode is added (series cards for new episodes, matching how
        // Jellyfin's "Latest" row worked pre-12.0). Movies use DateCreated.
        const response = await getItemsApi(api).getItems({
          userId: user?.Id,
          parentId,
          includeItemTypes,
          recursive: true,
          sortBy: includeItemTypes.includes("Series")
            ? ["DateLastContentAdded"]
            : ["DateCreated"],
          sortOrder: ["Descending"],
          startIndex: pageParam,
          limit: pageSize,
          fields: ["PrimaryImageAspectRatio"],
          imageTypeLimit: 1,
          enableImageTypes: ["Primary", "Backdrop", "Thumb"],
        });
        return response.data.Items || [];
      },
      type: "InfiniteScrollingCollectionList",
      pageSize,
      parentId,
      seeAllSort: {
        sortBy: SortByOption.DateCreated,
        sortOrder: SortOrderOption.Descending,
      },
    }),
    [api, user?.Id],
  );

  const defaultSections = useMemo(() => {
    if (!api || !user?.Id) return [];

    const latestMediaViews = collections.map((c) => {
      const includeItemTypes: BaseItemKind[] =
        c.CollectionType === "tvshows" ? ["Series"] : ["Movie"];
      const title = t("home.recently_added_in", { libraryName: c.Name });
      const queryKey: string[] = [
        "home",
        `recentlyAddedIn${c.CollectionType}`,
        user.Id!,
        c.Id!,
      ];
      return createCollectionConfig(
        title || "",
        queryKey,
        includeItemTypes,
        c.Id,
        10,
      );
    });

    // Helper to sort items by most recent activity
    const sortByRecentActivity = (items: BaseItemDto[]): BaseItemDto[] => {
      return items.sort((a, b) => {
        const dateA = a.UserData?.LastPlayedDate || a.DateCreated || "";
        const dateB = b.UserData?.LastPlayedDate || b.DateCreated || "";
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      });
    };

    // Helper to deduplicate items by ID
    const deduplicateById = (items: BaseItemDto[]): BaseItemDto[] => {
      const seen = new Set<string>();
      return items.filter((item) => {
        if (!item.Id || seen.has(item.Id)) return false;
        seen.add(item.Id);
        return true;
      });
    };

    // One row by default, two only if the viewer asked for them.
    //
    // pass-01 F-11, in Dan's words: "'Next up' text does not make sense to a
    // viewer". It is upstream vocabulary for "the next episode of something
    // you are part way through", which is the same sentence as "continue
    // watching" — so the merged row simply *is* Continue watching, rather than
    // a third name ("Continue & Next up") that explains the split it exists to
    // hide. The setting stays, for anyone who wants the two rows back.
    const firstSections: Section[] = settings.mergeNextUpAndContinueWatching
      ? [
          {
            title: t("home.continue_watching"),
            queryKey: ["home", "continueAndNextUp"],
            queryFn: async ({ pageParam = 0 }) => {
              // Fetch both in parallel
              const [resumeResponse, nextUpResponse] = await Promise.all([
                getItemsApi(api).getResumeItems({
                  userId: user.Id,
                  enableImageTypes: ["Primary", "Backdrop", "Thumb"],
                  includeItemTypes: ["Movie", "Series", "Episode"],
                  startIndex: 0,
                  limit: 20,
                }),
                getTvShowsApi(api).getNextUp({
                  userId: user?.Id,
                  startIndex: 0,
                  limit: 20,
                  enableImageTypes: ["Primary", "Backdrop", "Thumb"],
                  enableResumable: false,
                }),
              ]);

              const resumeItems = resumeResponse.data.Items || [];
              const nextUpItems = nextUpResponse.data.Items || [];

              // Combine, sort by recent activity, deduplicate
              const combined = [...resumeItems, ...nextUpItems];
              const sorted = sortByRecentActivity(combined);
              const deduplicated = deduplicateById(sorted);

              // Paginate client-side
              return deduplicated.slice(pageParam, pageParam + 10);
            },
            type: "InfiniteScrollingCollectionList",
            orientation: "horizontal",
            pageSize: 10,
            priority: 1,
          },
        ]
      : [
          {
            title: t("home.continue_watching"),
            queryKey: ["home", "resumeItems"],
            queryFn: async ({ pageParam = 0 }) =>
              (
                await getItemsApi(api).getResumeItems({
                  userId: user.Id,
                  enableImageTypes: ["Primary", "Backdrop", "Thumb"],
                  includeItemTypes: ["Movie", "Series", "Episode"],
                  startIndex: pageParam,
                  limit: 10,
                })
              ).data.Items || [],
            type: "InfiniteScrollingCollectionList",
            orientation: "horizontal",
            pageSize: 10,
            priority: 1,
          },
          {
            title: t("home.next_up"),
            queryKey: ["home", "nextUp-all"],
            queryFn: async ({ pageParam = 0 }) =>
              (
                await getTvShowsApi(api).getNextUp({
                  userId: user?.Id,
                  startIndex: pageParam,
                  limit: 10,
                  enableImageTypes: ["Primary", "Backdrop", "Thumb"],
                  enableResumable: false,
                })
              ).data.Items || [],
            type: "InfiniteScrollingCollectionList",
            orientation: "horizontal",
            pageSize: 10,
            priority: 1,
          },
        ];

    const ss: Section[] = [
      ...firstSections,
      ...latestMediaViews.map((s) => ({ ...s, priority: 2 as const })),
      // Only show Jellyfin suggested movies if StreamyStats recommendations are disabled
      ...(!settings?.streamyStatsMovieRecommendations
        ? [
            {
              title: t("home.suggested_movies"),
              queryKey: ["home", "suggestedMovies", user?.Id],
              queryFn: async ({ pageParam = 0 }: { pageParam?: number }) =>
                (
                  await getSuggestionsApi(api).getSuggestions({
                    userId: user?.Id,
                    startIndex: pageParam,
                    limit: 10,
                    mediaType: ["Video"],
                    type: ["Movie"],
                  })
                ).data.Items || [],
              type: "InfiniteScrollingCollectionList" as const,
              orientation: "vertical" as const,
              pageSize: 10,
              priority: 2 as const,
              // These are films out of the movie library, so "See all" opens
              // it — sorted by name, because "suggested" is not an order the
              // library screen can reproduce and pretending otherwise would
              // give the viewer a list that looks arbitrary.
              parentId: movieLibraryId,
              seeAllSort: {
                sortBy: SortByOption.SortName,
                sortOrder: SortOrderOption.Ascending,
              },
            },
          ]
        : []),
    ];
    return ss;
  }, [
    api,
    user?.Id,
    collections,
    t,
    createCollectionConfig,
    movieLibraryId,
    settings?.streamyStatsMovieRecommendations,
    settings.mergeNextUpAndContinueWatching,
  ]);

  const customSections = useMemo(() => {
    if (!api || !user?.Id || !settings?.home?.sections) return [];
    const ss: Section[] = [];
    settings.home.sections.forEach((section, index) => {
      const id = section.title || `section-${index}`;
      const pageSize = 10;
      ss.push({
        title: t(`${id}`),
        queryKey: ["home", "custom", String(index), section.title ?? null],
        queryFn: async ({ pageParam = 0 }) => {
          if (section.items) {
            const response = await getItemsApi(api).getItems({
              userId: user?.Id,
              startIndex: pageParam,
              limit: section.items?.limit || pageSize,
              recursive: true,
              includeItemTypes: section.items?.includeItemTypes,
              sortBy: section.items?.sortBy,
              sortOrder: section.items?.sortOrder,
              filters: section.items?.filters,
              parentId: section.items?.parentId,
            });
            return response.data.Items || [];
          }
          if (section.nextUp) {
            const response = await getTvShowsApi(api).getNextUp({
              userId: user?.Id,
              startIndex: pageParam,
              limit: section.nextUp?.limit || pageSize,
              enableImageTypes: ["Primary", "Backdrop", "Thumb"],
              enableResumable: section.nextUp?.enableResumable,
              enableRewatching: section.nextUp?.enableRewatching,
            });
            return response.data.Items || [];
          }
          if (section.latest) {
            // getLatestMedia doesn't support startIndex, so we fetch all and slice client-side
            const allData =
              (
                await getUserLibraryApi(api).getLatestMedia({
                  userId: user?.Id,
                  includeItemTypes: section.latest?.includeItemTypes,
                  limit: section.latest?.limit || 10,
                  isPlayed: section.latest?.isPlayed,
                  groupItems: section.latest?.groupItems,
                })
              ).data || [];

            // Simulate pagination by slicing
            return allData.slice(pageParam, pageParam + pageSize);
          }
          if (section.custom) {
            const response = await api.get<BaseItemDtoQueryResult>(
              section.custom.endpoint,
              {
                params: {
                  ...(section.custom.query || {}),
                  userId: user?.Id,
                  startIndex: pageParam,
                  limit: pageSize,
                },
                headers: section.custom.headers || {},
              },
            );
            return response.data.Items || [];
          }
          return [];
        },
        type: "InfiniteScrollingCollectionList",
        orientation: section?.orientation || "vertical",
        pageSize,
        // First 2 custom sections are high priority
        priority: index < 2 ? 1 : 2,
      });
    });
    return ss;
  }, [api, user?.Id, settings?.home?.sections, t]);

  const sections = settings?.home?.sections ? customSections : defaultSections;

  // Get all high priority section keys and check if all have loaded
  const highPrioritySectionKeys = useMemo(() => {
    return sections
      .filter((s) => s.priority === 1)
      .map((s) => s.queryKey.join("-"));
  }, [sections]);

  const allHighPriorityLoaded = useMemo(() => {
    return highPrioritySectionKeys.every((key) => loadedSections.has(key));
  }, [highPrioritySectionKeys, loadedSections]);

  const markSectionLoaded = useCallback(
    (queryKey: (string | undefined | null)[]) => {
      const key = queryKey.join("-");
      setLoadedSections((prev) => new Set(prev).add(key));
    },
    [],
  );

  if (!isConnected || serverConnected !== true) {
    let title = "";
    let subtitle = "";

    if (!isConnected) {
      title = t("home.no_internet");
      subtitle = t("home.no_internet_message");
    } else if (serverConnected === null) {
      title = t("home.checking_server_connection");
      subtitle = t("home.checking_server_connection_message");
    } else if (!serverConnected) {
      title = t("home.server_unreachable");
      subtitle = t("home.server_unreachable_message");
    }
    // One state, one shape: `EmptyState` draws the icon, the sentence and the
    // one action every other empty screen in the app draws. Downloads is the
    // second action and only exists where files can be downloaded — offering
    // it in a browser was the same class of mistake as "Delete all downloaded
    // files" appearing there.
    return (
      <PageContainer width='settings'>
        <EmptyState
          icon={serverConnected === null ? "refresh" : "warning"}
          title={title}
          detail={subtitle}
          action={{
            label: retryLoading ? t("common.loading") : t("home.retry"),
            onPress: retryCheck,
            icon: "refresh",
          }}
        />
        {!Platform.isTV && Platform.OS !== "web" ? (
          <Button
            variant='ghost'
            size='sm'
            icon='download'
            justify='center'
            onPress={() => router.push("/(auth)/downloads")}
          >
            {t("home.go_to_downloads")}
          </Button>
        ) : null}
      </PageContainer>
    );
  }

  if (e1)
    return (
      <PageContainer width='settings'>
        <EmptyState
          icon='error'
          title={t("home.oops")}
          detail={t("home.error_message")}
        />
      </PageContainer>
    );

  // A skeleton of the rows that are coming, not a spinner: the page fills in
  // rather than stalling, and nothing jumps when the first row lands.
  if (l1)
    return (
      <PageContainer width='media' bleed style={{ paddingTop: 16, gap: 24 }}>
        <HomeRowSkeleton />
        <HomeRowSkeleton />
        <HomeRowSkeleton />
      </PageContainer>
    );

  // Nothing to show, and something to do about it. Drawn only once the count has actually come
  // back, so a slow answer shows the rows filling in rather than flashing "empty" at somebody
  // whose library is fine.
  if (itemCount === 0)
    return (
      <PageContainer width='settings'>
        <EmptyState
          icon='library'
          title={t("home.empty_title")}
          detail={
            isAdmin ? t("home.empty_detail") : t("home.empty_detail_guest")
          }
          action={
            isAdmin
              ? {
                  label: t("home.empty_add_media"),
                  icon: "manage",
                  onPress: () => router.push("/settings/admin"),
                }
              : undefined
          }
        />
        <Button
          variant={isAdmin ? "ghost" : "primary"}
          size={isAdmin ? "sm" : "lg"}
          icon='requests'
          justify='center'
          onPress={() => router.push("/(auth)/(tabs)/(requests)")}
        >
          {t("home.empty_request")}
        </Button>
      </PageContainer>
    );

  return (
    <ScrollView
      ref={scrollRef}
      nestedScrollEnabled
      contentInsetAdjustmentBehavior='automatic'
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={refetch}
          tintColor='white'
          colors={["white"]}
        />
      }
      contentContainerStyle={{
        paddingLeft: insets.left,
        paddingRight: insets.right,
        paddingBottom: 32,
      }}
    >
      {/*
        `bleed`, because neither the hero nor a row is page content in the way
        a paragraph is: the hero is a full-bleed picture and a row's cards
        scroll past the gutter, and both apply the gutter themselves — to the
        hero's copy, to a row's first card and to its heading — so all three
        line up on one left edge. The container is still what stops the page
        running the whole width of a 2560 px monitor, and the hero is inside it
        for exactly that reason: a hero bled to the window with rows capped at
        1440 would start its title 230 px left of every heading below it.
      */}
      <PageContainer
        width='media'
        bleed
        style={{
          gap: 24,
        }}
      >
        <HomeHeroCarousel />
        {sections.map((section, index) => {
          // Render Streamystats sections after Recently Added sections
          // For default sections: place after Recently Added, before Suggested Movies (if present)
          // For custom sections: place at the very end
          const hasSuggestedMovies =
            !settings?.streamyStatsMovieRecommendations &&
            !settings?.home?.sections;
          const streamystatsIndex =
            sections.length - 1 - (hasSuggestedMovies ? 1 : 0);
          const hasStreamystatsContent =
            settings.streamyStatsMovieRecommendations ||
            settings.streamyStatsSeriesRecommendations ||
            settings.streamyStatsPromotedWatchlists;
          const streamystatsSections =
            index === streamystatsIndex && hasStreamystatsContent ? (
              <View key='streamystats-sections' style={{ gap: 24 }}>
                {settings.streamyStatsMovieRecommendations && (
                  <StreamystatsRecommendations
                    title={t(
                      "home.settings.plugins.streamystats.recommended_movies",
                    )}
                    type='Movie'
                    enabled={allHighPriorityLoaded}
                  />
                )}
                {settings.streamyStatsSeriesRecommendations && (
                  <StreamystatsRecommendations
                    title={t(
                      "home.settings.plugins.streamystats.recommended_series",
                    )}
                    type='Series'
                    enabled={allHighPriorityLoaded}
                  />
                )}
                {settings.streamyStatsPromotedWatchlists && (
                  <StreamystatsPromotedWatchlists
                    enabled={allHighPriorityLoaded}
                  />
                )}
              </View>
            ) : null;
          if (section.type === "InfiniteScrollingCollectionList") {
            const isHighPriority = section.priority === 1;
            // "See all" on every row that is a window onto a library, which
            // after this change is every row except the first.
            //
            // pass-02's complaint was that "Suggested movies" was the odd one
            // out — a row of films from the movie library with no way into it
            // while the rows above it had one. It has one now. "Continue
            // watching" is the one row that is not a slice of a library but a
            // list about you, and there is no screen of it to send anyone to;
            // inventing a destination that lands somewhere approximate would
            // be worse than the row not offering one.
            const handleSeeAll = section.parentId
              ? () => {
                  router.push({
                    pathname: "/(auth)/(tabs)/(libraries)/[libraryId]",
                    params: {
                      libraryId: section.parentId as string,
                      ...(section.seeAllSort ?? {}),
                    },
                  } as never);
                }
              : undefined;
            return (
              <View key={index} style={{ gap: 24 }}>
                <InfiniteScrollingCollectionList
                  testID='home-row'
                  title={section.title}
                  queryKey={section.queryKey}
                  queryFn={section.queryFn}
                  orientation={section.orientation}
                  hideIfEmpty
                  pageSize={section.pageSize}
                  enabled={isHighPriority || allHighPriorityLoaded}
                  onLoaded={
                    isHighPriority
                      ? () => markSectionLoaded(section.queryKey)
                      : undefined
                  }
                  onPressSeeAll={handleSeeAll}
                />
                {streamystatsSections}
              </View>
            );
          }
          if (section.type === "MediaListSection") {
            return (
              <View key={index} style={{ gap: 24 }}>
                <MediaListSection
                  queryKey={section.queryKey}
                  queryFn={section.queryFn}
                />
                {streamystatsSections}
              </View>
            );
          }
          return null;
        })}
      </PageContainer>
    </ScrollView>
  );
};

/** One row's worth of loading: the heading's width, then the cards' geometry. */
const HomeRowSkeleton = () => {
  const { gutter } = useBreakpoint();
  return (
    <View>
      <Skeleton
        width={180}
        height={18}
        radius={4}
        style={{ marginLeft: gutter, marginBottom: 12 }}
      />
      <CardRowSkeleton kind='portrait' count={6} />
    </View>
  );
};

// Exported component that renders TV or mobile version based on platform
export const Home = () => {
  if (Platform.isTV && HomeTV) {
    return <HomeTV />;
  }
  return <HomeMobile />;
};
