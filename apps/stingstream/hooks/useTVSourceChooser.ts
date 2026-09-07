/**
 * "Play from…" on television.
 *
 * The phone and web sheet does not exist here: TV modals are routes, not overlays
 * (`.claude/learned-facts/tv-modals-must-use-navigation-pattern`), so the chooser reuses the shared
 * option modal every other TV picker goes through instead of growing a second one.
 *
 * `deferApplyUntilDismissed` is the load-bearing flag. Choosing a source in the player replaces the
 * player — the same `router.replace` the audio switch does while transcoding — and a navigation
 * fired while the modal route is still on top is swallowed by it.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useTVOptionModal } from "@/hooks/useTVOptionModal";
import {
  formatSourceChoice,
  type SourceChoice,
} from "@/lib/stingstream/sourceChooser";
import type { TVOptionItem } from "@/utils/atoms/tvOptionModal";

export interface ShowSourceChooserParams {
  choices: readonly SourceChoice[];
  onSelect: (mediaSourceId: string) => void;
}

export const useTVSourceChooser = () => {
  const { t } = useTranslation();
  const { showOptions } = useTVOptionModal();

  const showSourceChooser = useCallback(
    ({ choices, onSelect }: ShowSourceChooserParams) => {
      const labels = {
        direct: t("player.source.direct"),
        relayed: t("player.source.relayed"),
        connecting: t("player.source.connecting"),
        offline: t("player.source.offline"),
        recommended: t("player.source.recommended"),
        sameFile: t("player.source.same_file"),
        playing: t("player.source.playing"),
      };

      // The modal has no notion of a disabled row, so an offline holder is listed with its badge
      // and simply does nothing when selected — the alternative is hiding it, which is the one
      // thing the list exists to avoid.
      const options: TVOptionItem<string>[] = choices.map((choice) => {
        const { title, subtitle, badges } = formatSourceChoice(choice, labels);
        return {
          label: badges.length ? `${title}  ·  ${badges.join(" · ")}` : title,
          sublabel: subtitle || undefined,
          value: choice.mediaSourceId,
          selected: choice.current,
        };
      });

      showOptions<string>({
        title: t("player.source.play_from"),
        options,
        deferApplyUntilDismissed: true,
        onSelect: (mediaSourceId) => {
          const choice = choices.find((c) => c.mediaSourceId === mediaSourceId);
          if (!choice || choice.disabled || choice.current) return;
          onSelect(mediaSourceId);
        },
      });
    },
    [showOptions, t],
  );

  return { showSourceChooser };
};
