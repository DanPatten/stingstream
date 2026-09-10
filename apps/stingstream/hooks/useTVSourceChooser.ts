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
import { formatSourceChoice } from "@/lib/stingstream/sourceChooser";
import {
  AUTO_KEY,
  type SourceMenuRow,
} from "@/lib/stingstream/sourceSelection";
import type { TVOptionItem } from "@/utils/atoms/tvOptionModal";

export interface ShowSourceChooserParams {
  /** Built by `useSourceSelection`, so the television and the phone cannot list different things. */
  menu: readonly SourceMenuRow[];
  /** What Auto currently resolves to, as one line. */
  autoTarget: string | null;
  /** `AUTO_KEY` or a `mediaSourceId` — the hook's `choose`. */
  onSelect: (key: string) => void;
}

export const useTVSourceChooser = () => {
  const { t } = useTranslation();
  const { showOptions } = useTVOptionModal();

  const showSourceChooser = useCallback(
    ({ menu, autoTarget, onSelect }: ShowSourceChooserParams) => {
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
      //
      // Auto is the first row, as it is on a phone, and its sublabel is what it comes to right
      // now. A television has no room for the Speed/Quality control the sheet puts underneath it;
      // that setting lives in Settings and this line is what makes its effect legible from here.
      const options: TVOptionItem<string>[] = menu.map((row) => {
        if (!row.choice) {
          return {
            label: t("player.source.auto"),
            sublabel: autoTarget
              ? t("player.source.auto_now", { source: autoTarget })
              : t("player.source.auto_nothing"),
            value: AUTO_KEY,
            selected: row.selected,
          };
        }

        const { title, subtitle, badges } = formatSourceChoice(
          row.choice,
          labels,
        );
        return {
          label: badges.length ? `${title}  ·  ${badges.join(" · ")}` : title,
          sublabel: subtitle || undefined,
          value: row.key,
          selected: row.selected,
        };
      });

      showOptions<string>({
        title: t("player.source.play_from"),
        options,
        deferApplyUntilDismissed: true,
        onSelect: (key) => {
          if (key === AUTO_KEY) {
            onSelect(key);
            return;
          }

          const row = menu.find((r) => r.key === key);
          if (!row?.choice || row.choice.disabled) return;
          onSelect(key);
        },
      });
    },
    [showOptions, t],
  );

  return { showSourceChooser };
};
