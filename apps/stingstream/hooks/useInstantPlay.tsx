import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getTvShowsApi, getUserLibraryApi } from "@jellyfin/sdk/lib/utils/api";
import { useAtomValue } from "jotai";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { toast } from "sonner-native";
import { ResumeChooser } from "@/components/item/ResumeChooser";
import { usePlayMedia } from "@/hooks/usePlayMedia";
import { useTVOptionModal } from "@/hooks/useTVOptionModal";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import {
  formatResumePosition,
  resumePositionTicks,
  shouldAskToResume,
} from "@/utils/resume";

/** Resolve fresh account progress and the next episode without visiting a details page. */
export function useInstantPlay() {
  const { t } = useTranslation();
  const { showOptions } = useTVOptionModal();
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const { settings } = useSettings();
  const playMedia = usePlayMedia();
  const busy = useRef(false);
  const [pending, setPending] = useState<BaseItemDto | null>(null);
  const start = useCallback(
    async (item: BaseItemDto, ticks: number) => {
      setPending(null);
      await playMedia(
        { itemId: item.Id!, offline: false, playbackPositionTicks: ticks },
        { item },
      );
    },
    [playMedia],
  );
  const play = useCallback(
    async (candidate: BaseItemDto) => {
      if (!api || !user?.Id || !candidate.Id || busy.current) return;
      busy.current = true;
      try {
        let id = candidate.Id;
        if (candidate.Type === "Series") {
          const next = await getTvShowsApi(api).getNextUp({
            userId: user.Id,
            seriesId: id,
            limit: 1,
          });
          let episode = next.data.Items?.[0];
          if (!episode) {
            const episodes = await getTvShowsApi(api).getEpisodes({
              userId: user.Id,
              seriesId: id,
              isMissing: false,
              limit: 1,
            });
            episode = episodes.data.Items?.[0];
          }
          if (!episode?.Id)
            throw new Error("No playable episode is available.");
          id = episode.Id;
        }
        const { data: item } = await getUserLibraryApi(api).getItem({
          userId: user.Id,
          itemId: id,
        });
        if (shouldAskToResume(item, settings)) {
          if (Platform.isTV)
            showOptions({
              title: item.Name ?? t("item.resume"),
              options: [
                {
                  label: t("item.resume_from", {
                    time: formatResumePosition(resumePositionTicks(item)),
                  }),
                  value: resumePositionTicks(item),
                  selected: true,
                },
                {
                  label: t("item.play_from_beginning"),
                  value: 0,
                  selected: false,
                },
              ],
              deferApplyUntilDismissed: true,
              onSelect: (ticks: number) => void start(item, ticks),
            });
          else setPending(item);
        } else await start(item, resumePositionTicks(item));
      } catch {
        toast.error(t("item.playback_start_failed"));
      } finally {
        busy.current = false;
      }
    },
    [api, user?.Id, settings, start, showOptions, t],
  );
  return {
    play,
    resumeDialog: Platform.isTV ? null : (
      <ResumeChooser
        visible={!!pending}
        title={pending?.Name ?? undefined}
        positionTicks={resumePositionTicks(pending)}
        onClose={() => setPending(null)}
        onResume={() =>
          pending && void start(pending, resumePositionTicks(pending))
        }
        onRestart={() => pending && void start(pending, 0)}
      />
    ),
  };
}
