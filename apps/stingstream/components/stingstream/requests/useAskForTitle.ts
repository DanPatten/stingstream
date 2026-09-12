import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner-native";
import { requestTitle, useCreateRequest } from "@/lib/stingstream/requests";

/** What a ten-foot ask needs to name a title. */
export interface AskTarget {
  tmdbId?: number;
  tvdbId?: number;
  title?: string | null;
  year?: number | null;
  posterUrl?: string | null;
  overview?: string | null;
  seasonCount?: number;
}

/**
 * The one request a remote control can make: all of it, now, with a toast.
 *
 * Shared by `TVRequestButton` and by a poster on a related or filmography row, so the two cannot
 * drift about what a press means or what it says afterwards.
 *
 * **No season picker, no reason, no approval screen, and that is the deal rather than a gap.** A
 * D-pad is a bad instrument for a multi-select, so "all of it" is the honest default for a control
 * with no way to say otherwise, and everything this cannot do is a phone away. The node collapses a
 * second ask onto the open request anyway, so pressing twice is safe.
 */
export function useAskForTitle() {
  const create = useCreateRequest();
  const { t } = useTranslation();

  const ask = useCallback(
    async (target: AskTarget) => {
      if (!target.tmdbId && !target.tvdbId) return;
      try {
        const made = await create.mutateAsync({
          tmdbId: target.tmdbId || undefined,
          tvdbId: target.tvdbId || undefined,
          // Empty means every season. See the note above.
          seasons: [],
          title: target.title ?? undefined,
          year: target.year,
          posterUrl: target.posterUrl,
          overview: target.overview,
          seasonCount: target.seasonCount,
        });

        const title = requestTitle(made);
        toast.success(
          made.state === "available"
            ? t("requests.toast_already_held", { title })
            : made.state === "pending"
              ? t("requests.toast_asked_pending", { title })
              : t("requests.toast_asked", { title }),
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [create, t],
  );

  return { ask, pending: create.isPending };
}
