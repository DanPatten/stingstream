import { useActionSheet } from "@expo/react-native-action-sheet";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type StyleProp, View, type ViewStyle } from "react-native";
import CastContext, {
  MediaHlsSegmentFormat,
  MediaHlsVideoSegmentFormat,
  MediaStreamType,
  type MediaTrack,
  PlayServicesState,
  useMediaStatus,
  useRemoteMediaClient,
} from "react-native-google-cast";
import { toast } from "sonner-native";
import { formatRemaining } from "@/components/item/metadata";
import useRouter from "@/hooks/useAppRouter";
import { useHaptic } from "@/hooks/useHaptic";
import { usePlayMedia } from "@/hooks/usePlayMedia";
import { resolveCastStreamUrl } from "@/lib/stingstream/castStreamUrl";
import { getDownloadedItemById } from "@/providers/Downloads/database";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useOfflineMode } from "@/providers/OfflineModeProvider";
import { useSettings } from "@/utils/atoms/settings";
import { getParentBackdropImageUrl } from "@/utils/jellyfin/image/getParentBackdropImageUrl";
import { getPrimaryImageUrl } from "@/utils/jellyfin/image/getPrimaryImageUrl";
import { getStreamUrl } from "@/utils/jellyfin/media/getStreamUrl";
import {
  getExternalSubtitleUrl,
  isExternalSubtitle,
} from "@/utils/jellyfin/subtitleUtils";
import { logAndCaptureError } from "@/utils/log";
import type { PlayRequest } from "@/utils/nativePlayer/playRequest";
import { chromecast } from "../utils/profiles/chromecast";
import { chromecasth265 } from "../utils/profiles/chromecasth265";
import { Button } from "./Button";
import { Dialog } from "./common/Dialog";
import { ProgressBar } from "./common/ProgressBar";
import type { SelectedOptions } from "./ItemContent";

interface Props {
  item: BaseItemDto;
  selectedOptions: SelectedOptions;
  /** Fills the row it sits in — the details page's action row does. */
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The one primary action on the pre-play page.
 *
 * **It is the accent, always.** It used to be tinted from the poster's own
 * palette (`useImageColorsReturn`), which meant the most important control in
 * the app was a different color on every title — a mustard bar on one film, a
 * washed-out lilac on the next — and on a dark poster it disappeared entirely
 * (plan bug 5). Poster color is atmosphere; it belongs behind the header, not
 * on the button you are looking for.
 *
 * The resume state is the label, not a second control: "Resume · 12m left" with
 * a progress rule under the button says both where you are and how much is
 * left, where the old full-width outline bar said "0m" and nothing else.
 */
export const PlayButton: React.FC<Props> = ({
  item,
  selectedOptions,
  fullWidth = false,
  style,
}: Props) => {
  const isOffline = useOfflineMode();
  const { showActionSheetWithOptions } = useActionSheet();
  const client = useRemoteMediaClient();
  const mediaStatus = useMediaStatus();
  const { t } = useTranslation();

  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);

  const router = useRouter();

  // Two questions this button sometimes has to ask, as dialogs rather than
  // `Alert.alert`: an alert is a native-only control that renders nothing at
  // all on the web, so on a browser the button simply did nothing.
  const [resumePrompt, setResumePrompt] = useState(false);
  const [downloadPrompt, setDownloadPrompt] = useState<number | null>(null);

  const { settings } = useSettings();
  const lightHapticFeedback = useHaptic("light");
  const playMedia = usePlayMedia();

  const handleNormalPlayFlow = useCallback(
    async (positionTicks: number) => {
      if (!item) return;

      const playRequest: PlayRequest = {
        itemId: item.Id!,
        audioIndex: selectedOptions.audioIndex,
        subtitleIndex: selectedOptions.subtitleIndex,
        mediaSourceId: selectedOptions.mediaSource?.Id ?? undefined,
        bitrateValue: selectedOptions.bitrate?.value,
        offline: isOffline,
        playbackPositionTicks: positionTicks,
      };

      if (!client) {
        await playMedia(playRequest, { item });
        return;
      }

      const options = ["Chromecast", "Device", "Cancel"];
      const cancelButtonIndex = 2;
      showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex,
        },
        async (selectedIndex: number | undefined) => {
          if (!api) return;
          const currentTitle = mediaStatus?.mediaInfo?.metadata?.title;
          const isOpeningCurrentlyPlayingMedia =
            currentTitle && currentTitle === item?.Name;

          switch (selectedIndex) {
            case 0:
              await CastContext.getPlayServicesState().then(async (state) => {
                if (state && state !== PlayServicesState.SUCCESS) {
                  CastContext.showPlayServicesErrorDialog(state);
                } else {
                  // Check if user wants H265 for Chromecast
                  const enableH265 = settings.enableH265ForChromecast;

                  // Validate required parameters before calling getStreamUrl
                  if (!api) {
                    console.warn("API not available for Chromecast streaming");
                    toast.error(t("player.missing_parameters"));
                    return;
                  }
                  if (!user?.Id) {
                    console.warn(
                      "User not authenticated for Chromecast streaming",
                    );
                    toast.error(t("player.missing_parameters"));
                    return;
                  }
                  if (!item?.Id) {
                    console.warn("Item not available for Chromecast streaming");
                    toast.error(t("player.missing_parameters"));
                    return;
                  }

                  // Get a new URL with the Chromecast device profile
                  try {
                    const data = await getStreamUrl({
                      api,
                      item,
                      deviceProfile: enableH265 ? chromecasth265 : chromecast,
                      startTimeTicks: positionTicks,
                      userId: user.Id,
                      audioStreamIndex: selectedOptions.audioIndex,
                      maxStreamingBitrate: selectedOptions.bitrate?.value,
                      mediaSourceId: selectedOptions.mediaSource?.Id,
                      subtitleStreamIndex: selectedOptions.subtitleIndex,
                    });

                    if (!data?.url) {
                      console.warn("No URL returned from getStreamUrl", data);
                      toast.error(
                        t("player.could_not_create_stream_for_chromecast"),
                      );
                      return;
                    }

                    // A federated item's mediaSource.Path is a stingstream.local mesh URL that no
                    // Chromecast receiver can ever resolve — not the raw form, and not the
                    // loopback rewrite the native player uses (utils/mesh/streamUrl.ts), since a
                    // receiver is a different device and can never reach this phone's 127.0.0.1.
                    // Race the source node's HTTPS side door for a URL the receiver actually can
                    // load; fall back to the home node's own gateway, which proxies the same path
                    // unauthenticated by design for exactly this case (docs/MESH.md §5, "This path
                    // shape is load-bearing"; docs/SIDEDOOR.md; M5 deliverable 4).
                    let castContentUrl = data.url;
                    if (
                      data.mediaSource?.IsRemote &&
                      data.mediaSource?.Protocol === "Http" &&
                      data.mediaSource?.Path &&
                      !data.mediaSource?.TranscodingUrl
                    ) {
                      try {
                        const resolved = await resolveCastStreamUrl({
                          jellyfinBasePath: api.basePath,
                          accessToken: api.accessToken,
                          federatedPath: data.mediaSource.Path,
                        });
                        if (resolved) {
                          castContentUrl = resolved.url;
                          if (resolved.warning) {
                            console.warn(
                              "[Chromecast] side-door fallback:",
                              resolved.warning,
                            );
                          }
                        }
                      } catch (e) {
                        // Keep whatever getStreamUrl returned (the unrewritten stingstream.local
                        // URL for this branch) rather than fail the cast outright — a receiver
                        // that cannot resolve it fails loudly through loadMedia's own error path
                        // below, which is more informative than aborting here.
                        logAndCaptureError(
                          "Chromecast side-door resolution failed",
                          e,
                        );
                      }
                    }

                    // Text subtitles ride along as sidecar VTT tracks the
                    // receiver renders itself (see the chromecast subtitle
                    // profile). The receiver fetches them without auth
                    // headers, so the api key must be in the URL.
                    const subtitleTracks: MediaTrack[] = (
                      data.mediaSource?.MediaStreams ?? []
                    )
                      .filter(
                        (s) => s.Type === "Subtitle" && isExternalSubtitle(s),
                      )
                      .flatMap((s) => {
                        const url = getExternalSubtitleUrl(s, {
                          offline: false,
                          basePath: api.basePath,
                        });
                        if (!url || s.Index == null) return [];
                        // Only server-relative URLs get the token — an
                        // IsExternalUrl sub lives on a third-party host that
                        // must never see the Jellyfin access token.
                        const needsApiKey =
                          !s.IsExternalUrl && !/[?&]api_?key=/i.test(url);
                        return [
                          {
                            id: s.Index,
                            type: "text" as const,
                            subtype: "subtitles" as const,
                            contentId: needsApiKey
                              ? `${url}${url.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(api.accessToken)}`
                              : url,
                            contentType: "text/vtt",
                            language: s.Language ?? "und",
                            name: s.DisplayTitle ?? undefined,
                          },
                        ];
                      });

                    // Calculate start time in seconds from playback position
                    const startTimeSeconds = positionTicks / 10000000;

                    // Calculate stream duration in seconds from runtime
                    const streamDurationSeconds = item.RunTimeTicks
                      ? item.RunTimeTicks / 10000000
                      : undefined;

                    // HLS transcodes must be declared as HLS, otherwise the
                    // receiver tries to parse the m3u8 playlist as an MP4 file
                    // and the cast session dies immediately. Checked against
                    // castContentUrl, not data.url: a federated item whose URL
                    // was replaced by the side-door resolution above is never
                    // HLS (it is a direct file, not a transcode), and using
                    // data.url here would just be reading the wrong string.
                    const isHls = castContentUrl.includes(".m3u8");
                    // Jellyfin puts the HLS segment container in the URL; the
                    // receiver needs the matching hint (HEVC only works in fMP4).
                    const isFmp4 = castContentUrl.includes(
                      "SegmentContainer=mp4",
                    );

                    client
                      .loadMedia({
                        mediaInfo: {
                          contentId: item.Id,
                          contentUrl: castContentUrl,
                          contentType: isHls
                            ? "application/x-mpegURL"
                            : "video/mp4",
                          ...(isHls && {
                            hlsSegmentFormat: isFmp4
                              ? MediaHlsSegmentFormat.FMP4
                              : MediaHlsSegmentFormat.TS,
                            hlsVideoSegmentFormat: isFmp4
                              ? MediaHlsVideoSegmentFormat.FMP4
                              : MediaHlsVideoSegmentFormat.MPEG2_TS,
                          }),
                          ...(subtitleTracks.length > 0 && {
                            mediaTracks: subtitleTracks,
                          }),
                          streamType: MediaStreamType.BUFFERED,
                          streamDuration: streamDurationSeconds,
                          metadata:
                            item.Type === "Episode"
                              ? {
                                  type: "tvShow",
                                  title: item.Name || "",
                                  episodeNumber: item.IndexNumber || 0,
                                  seasonNumber: item.ParentIndexNumber || 0,
                                  seriesTitle: item.SeriesName || "",
                                  images: [
                                    {
                                      url: getParentBackdropImageUrl({
                                        api,
                                        item,
                                        quality: 90,
                                        width: 2000,
                                      })!,
                                    },
                                  ],
                                }
                              : item.Type === "Movie"
                                ? {
                                    type: "movie",
                                    title: item.Name || "",
                                    subtitle: item.Overview || "",
                                    images: [
                                      {
                                        url: getPrimaryImageUrl({
                                          api,
                                          item,
                                          quality: 90,
                                          width: 2000,
                                        })!,
                                      },
                                    ],
                                  }
                                : {
                                    type: "generic",
                                    title: item.Name || "",
                                    subtitle: item.Overview || "",
                                    images: [
                                      {
                                        url: getPrimaryImageUrl({
                                          api,
                                          item,
                                          quality: 90,
                                          width: 2000,
                                        })!,
                                      },
                                    ],
                                  },
                        },
                        startTime: startTimeSeconds,
                      })
                      .then(() => {
                        const activeSubtitle = subtitleTracks.find(
                          (s) => s.id === selectedOptions.subtitleIndex,
                        );
                        if (activeSubtitle) {
                          client
                            .setActiveTrackIds([activeSubtitle.id])
                            .catch((e) => {
                              // Subtitles are silently missing on the cast
                              // device when this fails.
                              logAndCaptureError(
                                "Chromecast setActiveTrackIds failed",
                                e,
                              );
                            });
                        }
                        // state is already set when reopening current media, so skip it here.
                        if (isOpeningCurrentlyPlayingMedia) {
                          return;
                        }
                        CastContext.showExpandedControls();
                      })
                      .catch((e) => {
                        logAndCaptureError("Chromecast loadMedia failed", e);
                        toast.error(t("player.chromecast_playback_failed"));
                      });
                  } catch (e) {
                    logAndCaptureError("Chromecast stream setup failed", e);
                    toast.error(
                      t("player.could_not_create_stream_for_chromecast"),
                    );
                  }
                }
              });
              break;
            case 1:
              await playMedia(playRequest, { item });
              break;
            case cancelButtonIndex:
              break;
          }
        },
      );
    },
    [
      item,
      client,
      settings,
      api,
      user,
      router,
      showActionSheetWithOptions,
      mediaStatus,
      selectedOptions,
      playMedia,
      isOffline,
      t,
    ],
  );

  const startPlayback = useCallback(
    async (positionTicks: number) => {
      if (!item) return;

      // Check if item is downloaded
      const downloadedItem = item.Id
        ? getDownloadedItemById(item.Id)
        : undefined;

      // If already in offline mode, play downloaded file directly
      if (isOffline && downloadedItem) {
        await playMedia(
          {
            itemId: item.Id!,
            offline: true,
            playbackPositionTicks: positionTicks,
          },
          { item },
        );
        return;
      }

      // Online, but a copy is already on the device. Which one to play is a
      // real question — the download is instant and offline-proof, the stream
      // is whatever the server has now — so it gets asked rather than guessed.
      if (downloadedItem) {
        setDownloadPrompt(positionTicks);
        return;
      }

      // If not downloaded, proceed with normal flow
      handleNormalPlayFlow(positionTicks);
    },
    [item, isOffline, handleNormalPlayFlow, playMedia],
  );

  const playDownloaded = useCallback(
    (positionTicks: number) => {
      if (!item?.Id) return;
      void playMedia(
        {
          itemId: item.Id,
          offline: true,
          playbackPositionTicks: positionTicks,
        },
        { item },
      );
    },
    [item, playMedia],
  );

  const progressTicks = item?.UserData?.PlaybackPositionTicks ?? 0;
  const remaining = useMemo(
    () => formatRemaining(item?.RunTimeTicks, progressTicks),
    [item?.RunTimeTicks, progressTicks],
  );

  const onPress = useCallback(() => {
    if (!item) return;

    lightHapticFeedback();

    // Same prompt the TV item page shows: an in-progress item asks whether
    // to resume or restart instead of silently resuming. Users can turn the
    // prompt off in settings, in which case playback resumes right away.
    if (progressTicks > 0 && !settings.showResumeDialog) {
      void startPlayback(progressTicks);
      return;
    }
    if (progressTicks > 0) {
      setResumePrompt(true);
      return;
    }

    void startPlayback(0);
  }, [
    item,
    lightHapticFeedback,
    startPlayback,
    progressTicks,
    settings.showResumeDialog,
  ]);

  // "Resume · 12m left" when there is something to resume, "Play" otherwise.
  // Never a bare duration: the old button's whole label was the time remaining,
  // which said nothing about what pressing it would do.
  const label =
    progressTicks > 0 && remaining
      ? t("item.resume_left", { time: remaining })
      : t("item.play");

  return (
    <View style={[fullWidth ? { flex: 1 } : null, style]}>
      <Button
        testID='details-play'
        variant='primary'
        size='lg'
        icon='play'
        onPress={onPress}
        disabled={!item}
        accessibilityLabel={label}
        accessibilityHint={t("accessibility.play_hint")}
      >
        {label}
      </Button>
      {progressTicks > 0 ? (
        // The rule sits under the button rather than inside it: a fill that
        // grows across the accent is unreadable at 12 % and indistinguishable
        // from a disabled state at 90 %.
        <View style={{ marginTop: 6 }}>
          <ProgressBar item={item} />
        </View>
      ) : null}

      <Dialog
        visible={resumePrompt}
        onClose={() => setResumePrompt(false)}
        title={t("item_card.resume_playback")}
        description={t("item_card.resume_playback_description")}
        actions={[
          {
            label: t("item_card.play_from_start"),
            variant: "secondary",
            onPress: () => {
              setResumePrompt(false);
              void startPlayback(0);
            },
          },
          {
            label: remaining
              ? t("item.resume_left", { time: remaining })
              : t("item.resume"),
            onPress: () => {
              setResumePrompt(false);
              void startPlayback(progressTicks);
            },
          },
        ]}
      />

      <Dialog
        visible={downloadPrompt !== null}
        onClose={() => setDownloadPrompt(null)}
        title={t("player.downloaded_file_title")}
        description={t("player.downloaded_file_message")}
        actions={[
          {
            label: t("player.downloaded_file_no"),
            variant: "secondary",
            onPress: () => {
              const position = downloadPrompt ?? 0;
              setDownloadPrompt(null);
              handleNormalPlayFlow(position);
            },
          },
          {
            label: t("player.downloaded_file_yes"),
            onPress: () => {
              const position = downloadPrompt ?? 0;
              setDownloadPrompt(null);
              playDownloaded(position);
            },
          },
        ]}
      />
    </View>
  );
};
