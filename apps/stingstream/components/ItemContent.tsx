import type {
  BaseItemDto,
  MediaSourceInfo,
} from "@jellyfin/sdk/lib/generated-client/models";
import { getItemRefreshApi } from "@jellyfin/sdk/lib/utils/api";
import { useNavigation } from "expo-router";
import { useAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { toast } from "sonner-native";
import { type Bitrate } from "@/components/BitrateSelector";
import { HeaderButtonGroup } from "@/components/common/HeaderButton";
import { ItemImage } from "@/components/common/ItemImage";
import { PageContainer } from "@/components/common/PageContainer";
import { DownloadSingleItem } from "@/components/DownloadItem";
import { ActionRow } from "@/components/item/ActionRow";
import { DetailsHeader } from "@/components/item/DetailsHeader";
import { ItemPeopleSections } from "@/components/item/ItemPeopleSections";
import type { MoreMenuAction } from "@/components/item/MoreMenu";
import { streamsOf } from "@/components/item/metadata";
import { MediaSourceButton } from "@/components/MediaSourceButton";
import { OverviewText } from "@/components/OverviewText";
import { ParallaxScrollView } from "@/components/ParallaxPage";
import { Ratings } from "@/components/Ratings";
import { SimilarItems } from "@/components/SimilarItems";
import { CurrentSeries } from "@/components/series/CurrentSeries";
import { SeasonEpisodesCarousel } from "@/components/series/SeasonEpisodesCarousel";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import useDefaultPlaySettings from "@/hooks/useDefaultPlaySettings";
import { useOrientation } from "@/hooks/useOrientation";
import * as ScreenOrientation from "@/packages/expo-screen-orientation";
import { useDownload } from "@/providers/DownloadProvider";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useOfflineMode } from "@/providers/OfflineModeProvider";
import { useSettings } from "@/utils/atoms/settings";
import { logAndCaptureError } from "@/utils/log";
import { ItemTechnicalDetails } from "./ItemTechnicalDetails";
import { PlayInRemoteSessionButton } from "./PlayInRemoteSession";

const Chromecast = !Platform.isTV ? require("./Chromecast") : null;
const ItemContentTV = Platform.isTV
  ? require("./ItemContent.tv").ItemContentTV
  : null;

export type SelectedOptions = {
  bitrate: Bitrate;
  mediaSource: MediaSourceInfo | undefined;
  audioIndex: number | undefined;
  subtitleIndex: number;
};

interface ItemContentProps {
  item?: BaseItemDto | null;
  itemWithSources?: BaseItemDto | null;
  isLoading?: boolean;
}

/**
 * The parallax header on a phone.
 *
 * A poster, not a backdrop, and deliberately: at 390 dp a 2:3 poster is the
 * shape of the screen, and it is the image the title was designed for. The
 * *wide* layout is the one that has to use a backdrop, because a poster
 * stretched across 1440 px is the cropped strip pass-02 shipped (F-26).
 */
const COMPACT_HEADER_HEIGHT = {
  portrait: 460,
  episode: 260,
  landscape: 230,
} as const;

/** Vertical rhythm between the body's sections. */
const SECTION_GAP = 32;

// Mobile-specific implementation
const ItemContentMobile: React.FC<ItemContentProps> = ({
  item,
  itemWithSources,
}) => {
  const [api] = useAtom(apiAtom);
  const isOffline = useOfflineMode();
  const { getDownloadedItemById } = useDownload();
  // A download pins the tracks it was pulled with, and only the record knows
  // them: resolving against the server media source hands back an index for a
  // stream the local file may not contain.
  const downloadedTracks =
    isOffline && item?.Id
      ? getDownloadedItemById(item.Id)?.userData
      : undefined;
  const { settings } = useSettings();
  const { orientation } = useOrientation();
  const { isCompact } = useBreakpoint();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [user] = useAtom(userAtom);
  const { t } = useTranslation();

  const [headerHeight, setHeaderHeight] = useState<number>(
    COMPACT_HEADER_HEIGHT.portrait,
  );

  const [selectedOptions, setSelectedOptions] = useState<
    SelectedOptions | undefined
  >(undefined);

  // Use itemWithSources for play settings since it has MediaSources data
  const {
    defaultAudioIndex,
    defaultBitrate,
    defaultMediaSource,
    defaultSubtitleIndex,
  } = useDefaultPlaySettings(itemWithSources ?? item, settings);

  // Needs to automatically change the selected to the default values for default indexes.
  useEffect(() => {
    setSelectedOptions(() => ({
      bitrate: defaultBitrate,
      mediaSource: defaultMediaSource ?? undefined,
      subtitleIndex:
        downloadedTracks?.subtitleStreamIndex ?? defaultSubtitleIndex ?? -1,
      audioIndex: downloadedTracks?.audioStreamIndex ?? defaultAudioIndex,
    }));
  }, [
    defaultAudioIndex,
    defaultBitrate,
    defaultSubtitleIndex,
    defaultMediaSource,
    downloadedTracks,
  ]);

  // The header used to carry five unnamed icon buttons — download, remote
  // session, watched, favourite, watchlist — squeezed into a bar that also
  // holds the back arrow and the title (pass-02 F-24). Every one of them is now
  // a named control in the action row or the "…" menu, where there is room for
  // the word as well as the glyph. Casting is the exception: you have to be
  // able to *connect* to a receiver before Play can offer to use one.
  useEffect(() => {
    if (Platform.isTV) return;
    navigation.setOptions({
      headerRight: () =>
        item ? (
          <HeaderButtonGroup>
            <Chromecast.Chromecast />
          </HeaderButtonGroup>
        ) : null,
    });
  }, [item, navigation]);

  useEffect(() => {
    if (!item) return;
    if (orientation !== ScreenOrientation.OrientationLock.PORTRAIT_UP)
      setHeaderHeight(COMPACT_HEADER_HEIGHT.landscape);
    else if (item.Type === "Episode")
      setHeaderHeight(COMPACT_HEADER_HEIGHT.episode);
    else setHeaderHeight(COMPACT_HEADER_HEIGHT.portrait);
  }, [item, orientation]);

  const streams = useMemo(
    () => streamsOf(selectedOptions?.mediaSource, itemWithSources ?? item),
    [selectedOptions?.mediaSource, itemWithSources, item],
  );

  const isAdmin = Boolean(user?.Policy?.IsAdministrator);

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
    if (!item || !selectedOptions) return [];
    const actions: MoreMenuAction[] = [];

    if (!isOffline) {
      actions.push({
        key: "versions",
        icon: "sort",
        label: t("item.versions"),
        description: selectedOptions.mediaSource?.Name ?? undefined,
        trailing: (
          <MediaSourceButton
            selectedOptions={selectedOptions}
            setSelectedOptions={setSelectedOptions}
            item={itemWithSources}
          />
        ),
      });
    }

    // Downloading needs a filesystem. On the web the row would be a control
    // that cannot do anything, which is worse than its absence.
    if (Platform.OS !== "web" && !Platform.isTV && itemWithSources) {
      actions.push({
        key: "download",
        icon: "download",
        label: t("item.download"),
        trailing: <DownloadSingleItem item={itemWithSources} />,
      });
    }

    if (isAdmin && !settings.hideRemoteSessionButton && !isOffline) {
      actions.push({
        key: "remote",
        icon: "devices",
        label: t("item.play_on_device"),
        trailing: <PlayInRemoteSessionButton item={item} />,
      });
    }

    // WP-PLAYER owns "Play from…" (hooks/useItemSources +
    // components/stingstream/sources/SourceChooserButton). It renders nothing
    // unless the title is federated and more than one node holds it, so it can
    // be a permanent row here. Merging that branch adds:
    //
    //   actions.push({
    //     key: "play-from",
    //     icon: "sharing",
    //     label: t("player.source.play_from"),
    //     trailing: (
    //       <SourceChooserButton
    //         item={itemWithSources}
    //         currentMediaSourceId={selectedOptions.mediaSource?.Id}
    //         onSelect={preselectSource}
    //       />
    //     ),
    //   });

    if (isAdmin && !isOffline) {
      actions.push({
        key: "refresh",
        icon: "refresh",
        label: t("item.refresh_metadata"),
        onPress: () => void refreshMetadata(),
      });
    }

    return actions;
  }, [
    item,
    itemWithSources,
    selectedOptions,
    isOffline,
    isAdmin,
    settings.hideRemoteSessionButton,
    refreshMetadata,
    t,
  ]);

  if (!item || !selectedOptions) return null;

  const header = (
    <DetailsHeader
      item={item}
      streams={streams}
      meta={<Ratings item={item} />}
      actions={
        <ActionRow
          item={item}
          selectedOptions={selectedOptions}
          moreActions={moreActions}
        />
      }
    />
  );

  // Overview first, technical facts last — the order the critique asked for and
  // the order a person reads a film in.
  const body = (
    <PageContainer bleed style={{ paddingTop: 28, gap: SECTION_GAP }}>
      <OverviewText text={item.Overview} gutter />

      {item.Type === "Episode" ? <SeasonEpisodesCarousel item={item} /> : null}

      {item.Type === "Episode" && !isOffline ? (
        <CurrentSeries item={item} />
      ) : null}

      {item.Type !== "Program" ? <ItemPeopleSections item={item} /> : null}

      {item.Type !== "Program" && !isOffline ? (
        <SimilarItems itemId={item.Id} />
      ) : null}

      {!isOffline && streams.length > 0 ? (
        <ItemTechnicalDetails source={selectedOptions.mediaSource} />
      ) : null}
    </PageContainer>
  );

  const tail = <View style={{ height: insets.bottom + 48 }} />;

  if (isCompact) {
    return (
      <View
        className='flex-1 relative'
        style={{
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        <ParallaxScrollView
          className='flex-1'
          headerHeight={headerHeight}
          headerImage={
            <ItemImage
              variant='Primary'
              item={item}
              style={{ width: "100%", height: "100%" }}
            />
          }
        >
          {header}
          {body}
        </ParallaxScrollView>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: 0 }}
      showsVerticalScrollIndicator={false}
    >
      {header}
      {body}
      {tail}
    </ScrollView>
  );
};

// Memoize the mobile component
const MemoizedItemContentMobile = React.memo(ItemContentMobile);

// Exported component that renders TV or mobile version based on platform
export const ItemContent: React.FC<ItemContentProps> = (props) => {
  if (Platform.isTV && ItemContentTV) {
    return <ItemContentTV {...props} />;
  }
  return <MemoizedItemContentMobile {...props} />;
};
