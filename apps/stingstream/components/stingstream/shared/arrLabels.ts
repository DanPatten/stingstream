import type { TFunction } from "i18next";

/**
 * The movie manager's and the series manager's own internal identifiers
 * ("radarr" / "sonarr") reach the UI verbatim wherever the server hands back
 * its own field unchanged — a queue entry's app, a history record's app, a
 * calendar entry's app, a download's app. That is data, not text this app
 * wrote, so the brand guard's static scan of string literals cannot catch
 * it, and Dan's "zero user-visible Radarr/Sonarr" rule still applies. Every
 * place that would otherwise print one of those two words raw goes through
 * one of these instead.
 */

const KEY_FOR: Record<string, "movie" | "series"> = {
  radarr: "movie",
  sonarr: "series",
};

/** Title-case, for a heading or a short standalone tag: "Movie manager". */
export function arrAppLabel(
  t: TFunction,
  app: string | null | undefined,
): string {
  const kind = KEY_FOR[(app ?? "").toLowerCase()];
  if (kind === "movie") return t("manage.movie_manager_label");
  if (kind === "series") return t("manage.series_manager_label");
  return app ?? "";
}

/** Lower case with an article, for a sentence fragment: "the movie manager". */
export function arrAppLabelWithArticle(
  t: TFunction,
  app: string | null | undefined,
): string {
  const kind = KEY_FOR[(app ?? "").toLowerCase()];
  if (kind === "movie") return t("manage.movie_manager");
  if (kind === "series") return t("manage.series_manager");
  return app ?? "";
}
