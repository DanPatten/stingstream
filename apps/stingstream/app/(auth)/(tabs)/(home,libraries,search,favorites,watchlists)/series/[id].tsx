import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getItemRefreshApi, getTvShowsApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useAtom } from "jotai";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { toast } from "sonner-native";
import { HeaderIcon } from "@/components/common/HeaderIcon";
import { PageContainer } from "@/components/common/PageContainer";
import { SectionHeader } from "@/components/common/SectionHeader";
import { Image } from "@/components/common/ServerImage";
import { DownloadItems } from "@/components/DownloadItem";
import { ActionRow } from "@/components/item/ActionRow";
import { DetailsHeader } from "@/components/item/DetailsHeader";
import { ItemPeopleSections } from "@/components/item/ItemPeopleSections";
import type { MoreMenuAction } from "@/components/item/MoreMenu";
import { OverviewText } from "@/components/OverviewText";
import { ParallaxScrollView } from "@/components/ParallaxPage";
import { Ratings } from "@/components/Ratings";
import { SimilarItems } from "@/components/SimilarItems";
import { NextUp } from "@/components/series/NextUp";
import { SeasonPicker } from "@/components/series/SeasonPicker";
import { TVSeriesPage } from "@/components/series/TVSeriesPage";
import { useSetScreenTitle } from "@/components/shell/useScreenTitle";
import { ManageTitleSheet } from "@/components/stingstream/arr/ManageTitleSheet";
import { SourceSelector } from "@/components/stingstream/sources/SourceSelector";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import useDefaultPlaySettings from "@/hooks/useDefaultPlaySettings";
import { useTheme } from "@/hooks/useTheme";
import { useArrTitle } from "@/lib/stingstream/hooks";
import { useDownload } from "@/providers/DownloadProvider";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { OfflineModeProvider } from "@/providers/OfflineModeProvider";
import { useSettings } from "@/utils/atoms/settings";
import {
  buildOfflineSeriesFromEpisodes,
  getDownloadedEpisodesForSeries,
} from "@/utils/downloads/offline-series";
import { getPrimaryImageUrl } from "@/utils/jellyfin/image/getPrimaryImageUrl";
import { getUserItemData } from "@/utils/jellyfin/user-library/getUserItemData";
import { logAndCaptureError } from "@/utils/log";
import { storage } from "@/utils/mmkv";

/** Same rhythm as the movie/episode page, so the two read as one screen. */
const SECTION_GAP = 32;
const COMPACT_HEADER_HEIGHT = 460;

const page: React.FC = () => {
  const { color } = useTheme();
  const navigation = useNavigation();
  const router = useRouter();
  const { t } = useTranslation();
  const params = useLocalSearchParams();
  const {
    id: seriesId,
    seasonIndex,
    offline: offlineParam,
  } = params as {
    id: string;
    seasonIndex: string;
    offline?: string;
  };

  const isOffline = offlineParam === "true";

  const [api] = useAtom(apiAtom);
  const [user] = useAtom(userAtom);
  const insets = useSafeAreaInsets();
  const { isCompact } = useBreakpoint();
  const { getDownloadedItems, downloadedItems } = useDownload();

  // For offline mode, construct series data from downloaded episodes
  // Include downloadedItems.length so query refetches when items are deleted
  const { data: item } = useQuery({
    queryKey: ["series", seriesId, isOffline, downloadedItems.length],
    queryFn: async () => {
      if (isOffline) {
        return buildOfflineSeriesFromEpisodes(getDownloadedItems(), seriesId);
      }
      return await getUserItemData({
        api,
        userId: user?.Id,
        itemId: seriesId,
      });
    },
    staleTime: isOffline ? Infinity : 60 * 1000,
    refetchInterval: !isOffline && Platform.isTV ? 60 * 1000 : undefined,
    enabled: isOffline || (!!api && !!user?.Id),
  });

  // For offline mode, use stored base64 image
  const base64Image = useMemo(() => {
    if (isOffline) {
      return storage.getString(seriesId);
    }
    return null;
  }, [isOffline, seriesId]);

  const posterUrl = useMemo(() => {
    if (isOffline && base64Image) {
      return `data:image/jpeg;base64,${base64Image}`;
    }
    return getPrimaryImageUrl({ api, item, quality: 90, width: 800 });
  }, [isOffline, base64Image, api, item]);

  const { data: allEpisodes, isLoading } = useQuery({
    queryKey: ["AllEpisodes", seriesId, isOffline, downloadedItems.length],
    queryFn: async () => {
      if (isOffline) {
        return getDownloadedEpisodesForSeries(getDownloadedItems(), seriesId);
      }
      if (!api || !user?.Id) return [];

      const res = await getTvShowsApi(api).getEpisodes({
        seriesId: seriesId,
        userId: user.Id,
        enableUserData: true,
        fields: ["MediaSources", "MediaStreams", "Overview", "Trickplay"],
      });
      return res?.data.Items || [];
    },
    select: (data) =>
      [...(data || [])].sort(
        (a, b) =>
          (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) ||
          (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0),
      ),
    staleTime: isOffline ? Infinity : 60 * 1000,
    refetchInterval: !isOffline && Platform.isTV ? 60 * 1000 : undefined,
    enabled: isOffline || (!!api && !!user?.Id),
  });

  // WP5: the header used to carry a favourite button and a download-series
  // button with no names on them. Both are named rows on the page itself now —
  // the header is back and title, which is all a detail page's header is for.
  useEffect(() => {
    if (Platform.isTV) return;
    navigation.setOptions({ headerRight: () => null });
  }, [navigation]);

  // The top bar names the series rather than the tab a pasted URL landed in.
  useSetScreenTitle(item?.Name);

  // A series has no file of its own, so its Play is the next episode you have
  // not finished — the first unwatched one, or the first one at all on a show
  // nobody has started. Without this the page's primary action was a "Next up"
  // row three sections down, which is not a primary action.
  const nextEpisode = useMemo(() => {
    const episodes = allEpisodes ?? [];
    return (
      episodes.find(
        (episode) =>
          !episode.UserData?.Played ||
          (episode.UserData?.PlaybackPositionTicks ?? 0) > 0,
      ) ?? episodes[0]
    );
  }, [allEpisodes]);

  const { settings } = useSettings();
  const {
    defaultAudioIndex,
    defaultBitrate,
    defaultMediaSource,
    defaultSubtitleIndex,
  } = useDefaultPlaySettings(nextEpisode, settings);

  // Play here goes straight into the player, so "which server?" has to be answerable *on this
  // screen* — there is no episode details page in between to ask it on, the way there is on
  // television. The pin itself is filed against the series, so a choice made here is the show's.
  const [chosenSourceId, setChosenSourceId] = useState<string | null>(null);

  const playOptions = useMemo(() => {
    if (!nextEpisode) return undefined;
    const chosen = chosenSourceId
      ? nextEpisode.MediaSources?.find((s) => s.Id === chosenSourceId)
      : undefined;
    return {
      bitrate: defaultBitrate,
      mediaSource: chosen ?? defaultMediaSource ?? undefined,
      audioIndex: defaultAudioIndex,
      subtitleIndex: defaultSubtitleIndex ?? -1,
    };
  }, [
    nextEpisode,
    chosenSourceId,
    defaultBitrate,
    defaultMediaSource,
    defaultAudioIndex,
    defaultSubtitleIndex,
  ]);

  const isAdmin = Boolean(user?.Policy?.IsAdministrator);

  // What this node's series manager does about this show, if it manages it at
  // all — on a pooled library it may be held by another node entirely.
  const tvdbId = Number(item?.ProviderIds?.Tvdb) || undefined;
  const managed = useArrTitle("series", tvdbId, isAdmin && !isOffline);
  const [managing, setManaging] = useState(false);

  const refreshMetadata = useCallback(async () => {
    if (!api || !item?.Id) return;
    try {
      await getItemRefreshApi(api).refreshItem({
        itemId: item.Id,
        metadataRefreshMode: "FullRefresh",
        imageRefreshMode: "FullRefresh",
      });
      toast.success(t("item.refresh_started"));
    } catch (error) {
      logAndCaptureError("Refresh metadata failed", error);
      toast.error(t("item.refresh_failed"));
    }
  }, [api, item?.Id, t]);

  const moreActions = useMemo<MoreMenuAction[]>(() => {
    const actions: MoreMenuAction[] = [];
    const episodes: BaseItemDto[] = allEpisodes ?? [];

    if (
      Platform.OS !== "web" &&
      !Platform.isTV &&
      !isOffline &&
      episodes.length > 0
    ) {
      actions.push({
        key: "download-series",
        icon: "download",
        label: t("item_card.download.download_series"),
        trailing: (
          <DownloadItems
            title={t("item_card.download.download_series")}
            items={episodes}
            MissingDownloadIconComponent={() => <HeaderIcon name='downloads' />}
            DownloadedIconComponent={() => (
              <HeaderIcon name='downloaded' tintColor={color.accent[500]} />
            )}
          />
        ),
      });
    }

    if (isAdmin && !isOffline) {
      actions.push({
        key: "refresh",
        icon: "refresh",
        label: t("item.refresh_metadata"),
        onPress: () => void refreshMetadata(),
      });
    }

    // Only for a show this server actually manages: the one row here that
    // changes what the server does rather than what this session sees.
    if (managed.row) {
      actions.push({
        key: "manage",
        icon: "settings",
        label: t("item.manage_title"),
        description: managed.profileName,
        onPress: () => setManaging(true),
      });
    }

    return actions;
  }, [
    allEpisodes,
    isAdmin,
    isOffline,
    refreshMetadata,
    managed.row,
    managed.profileName,
    t,
  ]);

  if (!item) return null;

  // TV version
  if (Platform.isTV) {
    return (
      <OfflineModeProvider isOffline={isOffline}>
        <TVSeriesPage
          item={item}
          allEpisodes={allEpisodes}
          isLoading={isLoading}
          initialSeasonIndex={Number(seasonIndex)}
        />
      </OfflineModeProvider>
    );
  }

  const header = (
    <DetailsHeader
      item={item}
      meta={<Ratings item={item} />}
      actions={
        <>
          <ActionRow
            // Play belongs to the episode; everything else belongs to the series.
            item={item}
            playItem={nextEpisode}
            selectedOptions={playOptions}
            moreActions={moreActions}
          />
          {!isOffline ? (
            <SourceSelector
              item={nextEpisode}
              currentMediaSourceId={playOptions?.mediaSource?.Id}
              onSelect={setChosenSourceId}
              style={{ marginTop: 12 }}
            />
          ) : null}
        </>
      }
    />
  );

  const body = (
    <PageContainer bleed style={{ paddingTop: 28, gap: SECTION_GAP }}>
      <OverviewText text={item.Overview} gutter />

      {!isOffline ? <NextUp seriesId={seriesId} /> : null}

      <View testID='details-episodes'>
        <SectionHeader title={t("item.episodes")} />
        <SeasonPicker item={item} initialSeasonIndex={Number(seasonIndex)} />
      </View>

      <ItemPeopleSections item={item} showFilmographies={false} />

      {!isOffline ? <SimilarItems itemId={item.Id} /> : null}
    </PageContainer>
  );

  const manageSheet =
    managed.row && tvdbId ? (
      <ManageTitleSheet
        kind='series'
        providerId={tvdbId}
        title={item.Name ?? ""}
        monitored={managed.row.monitored ?? false}
        visible={managing}
        onClose={() => setManaging(false)}
        // The show and its files are gone; this page is showing something that
        // no longer exists.
        onRemovedWithFiles={() => router.back()}
      />
    ) : null;

  return (
    <OfflineModeProvider isOffline={isOffline}>
      {isCompact ? (
        <ParallaxScrollView
          headerHeight={COMPACT_HEADER_HEIGHT}
          headerImage={
            posterUrl ? (
              <Image
                source={posterUrl}
                style={{ width: "100%", height: "100%" }}
                contentFit='cover'
                cachePolicy='memory-disk'
                transition={300}
              />
            ) : (
              <View style={{ width: "100%", height: "100%" }} />
            )
          }
        >
          {header}
          {body}
        </ParallaxScrollView>
      ) : (
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          {header}
          {body}
          <View style={{ height: insets.bottom + 48 }} />
        </ScrollView>
      )}
      {manageSheet}
    </OfflineModeProvider>
  );
};

export default page;
