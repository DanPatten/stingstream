import type { TFunction } from "i18next";

/**
 * Radarr's and Sonarr's own internal identifiers ("radarr" / "sonarr") reach the UI verbatim
 * wherever the server hands back its own field unchanged — a queue entry's app, a history
 * record's app, a calendar entry's app, a download's app. That is data, not text this app wrote,
 * so the brand guard's static scan of string literals cannot catch it. Every place that would
 * otherwise print one of those two words raw comes through here instead.
 *
 * **What they turn into is "Movies" and "Series", not two managers.** StingStream is one
 * application (root `CLAUDE.md`, "StingStream is one app"), so the only split a reader may be
 * shown is the one that is true of their own library rather than of our process table. That also
 * happens to be what these fields actually mean to somebody reading a queue: not "which service
 * fetched this" but "is this a movie or a series".
 */

const KEY_FOR: Record<string, "movie" | "series"> = {
  radarr: "movie",
  sonarr: "series",
};

/** Title-case, for a heading or a short standalone tag: "Movies", "Series". */
export function arrAppLabel(
  t: TFunction,
  app: string | null | undefined,
): string {
  const kind = KEY_FOR[(app ?? "").toLowerCase()];
  if (kind === "movie") return t("manage.movie_manager_label");
  if (kind === "series") return t("manage.series_manager_label");
  return app ?? "";
}

/** Lower case with an article, for a sentence fragment: "tracked as a movie". */
export function arrAppLabelWithArticle(
  t: TFunction,
  app: string | null | undefined,
): string {
  const kind = KEY_FOR[(app ?? "").toLowerCase()];
  if (kind === "movie") return t("manage.movie_manager");
  if (kind === "series") return t("manage.series_manager");
  return app ?? "";
}
