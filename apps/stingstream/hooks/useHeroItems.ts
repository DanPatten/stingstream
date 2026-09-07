import type { Api } from "@jellyfin/sdk";
import type {
  BaseItemDto,
  BaseItemKind,
} from "@jellyfin/sdk/lib/generated-client/models";
import {
  getItemsApi,
  getTvShowsApi,
  getUserLibraryApi,
} from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { HeroCarouselFilterSection } from "@/modules";
import { isHeroAvailable } from "@/modules";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  type HomeHeroMediaType,
  type HomeHeroSection,
  useSettings,
} from "@/utils/atoms/settings";
import { apportion } from "@/utils/hero/apportion";
import { getBackdropUrl } from "@/utils/jellyfin/image/getBackdropUrl";
import { getLogoImageUrlById } from "@/utils/jellyfin/image/getLogoImageUrlById";
import { getParentBackdropImageUrl } from "@/utils/jellyfin/image/getParentBackdropImageUrl";
import { getPrimaryImageUrl } from "@/utils/jellyfin/image/getPrimaryImageUrl";
import { formatRuntimeTicks } from "@/utils/time";

export type HeroSection = HomeHeroSection;

const IMAGE_TYPES = ["Primary", "Backdrop", "Logo", "Thumb"] as const;

/** The hero always aims for this many slides, whatever is filtered out. */
export const HERO_TARGET_COUNT = 10;

/**
 * Relative share of the hero each group gets when everything is enabled:
 * 2 continue-watching, 2 next-up, 6 recently added (3 movies + 3 TV).
 * Disabling a group redistributes its share across the ones that remain, in
 * proportion to these weights, rather than simply shortening the hero.
 */
const GROUP_WEIGHTS: Record<HeroSection, number> = {
  continueWatching: 2,
  nextUp: 2,
  recentlyAdded: 6,
};

/**
 * How many items to request for a quota of `n`. Dedup (same item or same
 * series across groups) eats candidates, and the leftovers are what backfill
 * a bucket that comes up short, so every bucket fetches spare capacity.
 *
 * The floor matters for F-38: on a brand-new account resume and next-up are
 * both empty, and every slide the hero shows has to come out of the
 * recently-added buckets' spare capacity.
 */
const overFetch = (quota: number) =>
  quota <= 0 ? 0 : Math.min(quota * 2 + 4, HERO_TARGET_COUNT * 2);

/**
 * The chip on a slide.
 *
 * Next-up deliberately shares "Continue watching" (pass-01 F-11: "Next up"
 * means nothing to a viewer, and the home row merges the two by default now —
 * the hero saying something different about the same episode would be worse
 * than either name on its own). The two are still separate *sources*, with
 * separate filters; only the label they wear is shared.
 */
const SECTION_LABEL_KEYS: Record<HeroSection, string> = {
  continueWatching: "home.continue_watching",
  nextUp: "home.continue_watching",
  recentlyAdded: "home.recently_added",
};

/** Menu-row labels, which name the *sources* rather than what a slide is. */
const SECTION_MENU_KEYS: Record<HeroSection, string> = {
  continueWatching: "home.continue_watching",
  nextUp: "home.next_up",
  recentlyAdded: "home.recently_added",
};

/** SF Symbol per section, for the native iOS view. */
const SECTION_ICONS: Record<HeroSection, string> = {
  continueWatching: "play.fill",
  nextUp: "forward.fill",
  recentlyAdded: "sparkles",
};

/** Menu row keys, namespaced so one event handler can route every row. */
export const SECTION_KEY_PREFIX = "section:";
export const MEDIA_KEY_PREFIX = "media:";
/** Turns the whole hero off; also lives in the app's appearance settings. */
export const VISIBILITY_KEY = "visibility:hero";

const ALL_SECTIONS: HomeHeroSection[] = [
  "continueWatching",
  "nextUp",
  "recentlyAdded",
];
const ALL_MEDIA_TYPES: HomeHeroMediaType[] = ["movie", "tv"];

const MEDIA_LABEL_KEYS: Record<HomeHeroMediaType, string> = {
  movie: "common.movies",
  tv: "home.hero.tv_shows",
};

const toggleHidden = <T extends string>(hidden: T[], value: T): T[] =>
  hidden.includes(value)
    ? hidden.filter((entry) => entry !== value)
    : [...hidden, value];

/**
 * Which slide sources survive a filter state. Shared by the query and by the
 * menu's guard so the two can't drift apart.
 */
const resolveSources = (
  hiddenSections: HomeHeroSection[],
  hiddenMediaTypes: HomeHeroMediaType[],
) => {
  const showMovies = !hiddenMediaTypes.includes("movie");
  const showTv = !hiddenMediaTypes.includes("tv");
  const showContinueWatching =
    !hiddenSections.includes("continueWatching") && (showMovies || showTv);
  // Next up is episodes only, so it disappears with the TV media type.
  const showNextUp = !hiddenSections.includes("nextUp") && showTv;
  const showRecentlyAdded =
    !hiddenSections.includes("recentlyAdded") && (showMovies || showTv);
  return {
    showMovies,
    showTv,
    showContinueWatching,
    showNextUp,
    showRecentlyAdded,
  };
};

/**
 * Whether a filter state leaves anything to show. The two hidden-lists have
 * to be judged together, not one at a time: Next Up is episodes-only, so
 * hiding the other two groups and then hiding TV silences every source even
 * though each of those toggles is legal on its own. An empty hero takes
 * the filter menu down with it, so such a combination is refused.
 */
export const hasAnySource = (
  hiddenSections: HomeHeroSection[],
  hiddenMediaTypes: HomeHeroMediaType[],
): boolean => {
  const sources = resolveSources(hiddenSections, hiddenMediaTypes);
  return (
    sources.showContinueWatching ||
    sources.showNextUp ||
    sources.showRecentlyAdded
  );
};

const isTvChild = (item: BaseItemDto) =>
  item.Type === "Episode" || item.Type === "Season";

/** Everything that isn't a movie is TV (Series, Season, Episode). */
const mediaTypeOf = (item: BaseItemDto): HomeHeroMediaType =>
  item.Type === "Movie" ? "movie" : "tv";

/**
 * The second line: which episode this is.
 *
 * "S1 E3 · Episode title", spelled the same way the cards below spell it
 * (pass-01 F-11) and the same way the TV hero already did.
 */
export const buildSubtitle = (item: BaseItemDto): string | null => {
  if (item.Type === "Episode") {
    const season = item.ParentIndexNumber;
    const episode = item.IndexNumber;
    const code =
      season != null && episode != null ? `S${season} E${episode}` : null;
    if (code && item.Name) return `${code} · ${item.Name}`;
    return item.Name || code;
  }
  if (item.Type === "Season") return item.Name || null;
  return null;
};

/**
 * Which picture this item can actually put behind a full-bleed hero.
 *
 * `getBackdropUrl` builds a URL for any item at all, tag or no tag, so an
 * item the server holds no image for comes back as a 404 — a black hero and a
 * console error, which is exactly what F-23 and F-38 are about. The tags are
 * the only honest answer, so they are read here and the hero prefers slides
 * that have a real 16:9 backdrop over ones that would only have a poster.
 */
type BackdropSource = "parent" | "own" | "primary" | null;

const backdropSourceOf = (item: BaseItemDto): BackdropSource => {
  // Episodes/seasons: the series backdrop beats the episode still.
  if (
    isTvChild(item) &&
    item.ParentBackdropItemId &&
    item.ParentBackdropImageTags?.length
  ) {
    return "parent";
  }
  if (item.BackdropImageTags?.length) return "own";
  if (item.ImageTags?.Primary) return "primary";
  return null;
};

/** A real landscape backdrop, as opposed to a poster standing in for one. */
const hasTrueBackdrop = (item: BaseItemDto): boolean => {
  const source = backdropSourceOf(item);
  return source === "parent" || source === "own";
};

export const buildBackdropUrl = (
  api: Api,
  item: BaseItemDto,
  width: number,
): string | null => {
  switch (backdropSourceOf(item)) {
    case "parent":
      return getParentBackdropImageUrl({ api, item, quality: 80, width });
    case "own":
      return getBackdropUrl({ api, item, quality: 80, width });
    case "primary":
      return getPrimaryImageUrl({ api, item, quality: 80, width });
    default:
      // No tag anywhere: a URL here would be a 404 the hero renders as black.
      return null;
  }
};

export const buildLogoUrl = (api: Api, item: BaseItemDto): string | null => {
  // Handles the item's own logo and the Episode → parent logo case.
  const own = getLogoImageUrlById({ api, item, height: 120 });
  if (own) return own;
  // Seasons carry the series logo only through the Parent* fields.
  if (item.ParentLogoItemId && item.ParentLogoImageTag) {
    const params = new URLSearchParams({
      tag: item.ParentLogoImageTag,
      quality: "90",
      fillHeight: "120",
    });
    return `${api.basePath}/Items/${item.ParentLogoItemId}/Images/Logo?${params.toString()}`;
  }
  return null;
};

export const buildPosterUrl = (api: Api, item: BaseItemDto): string | null => {
  // An episode's Primary is a 16:9 still that crops badly in the portrait
  // thumb slot; use the series poster instead.
  if (item.Type === "Episode" && item.SeriesId && item.SeriesPrimaryImageTag) {
    const params = new URLSearchParams({
      tag: item.SeriesPrimaryImageTag,
      quality: "90",
      fillWidth: "240",
    });
    return `${api.basePath}/Items/${item.SeriesId}/Images/Primary?${params.toString()}`;
  }
  if (!item.ImageTags?.Primary) return null;
  return getPrimaryImageUrl({ api, item, width: 240 });
};

export const buildBadges = (item: BaseItemDto): string[] => {
  const badges: string[] = [];
  if (item.ProductionYear) badges.push(String(item.ProductionYear));
  if (item.OfficialRating) badges.push(item.OfficialRating);
  // The local `buildRuntimeBadge` that used to live here is gone: `utils/time`'s
  // own formatter counts seconds under a minute now, so the workaround for
  // `runtimeTicksToMinutes` flooring a twenty-second clip to "0m" is redundant
  // (WP5 follow-up to pass-02 F-26).
  const runtime = formatRuntimeTicks(item.RunTimeTicks);
  if (runtime) badges.push(runtime);
  return badges;
};

type HeroEntry = { item: BaseItemDto; section: HeroSection };

/** One slide, with every string and URL already resolved. */
export interface HeroSlide {
  id: string;
  /** The item itself, for navigation and the play/resume decision. */
  item: BaseItemDto;
  section: HeroSection;
  /** Series name for an episode, the item's own name otherwise. */
  title: string;
  /** "S1 E3 · Episode title", or null for anything that isn't an episode. */
  subtitle: string | null;
  overview: string;
  /** Pre-localized chip text: "Continue watching" / "Recently added". */
  label: string;
  /** SF Symbol for the chip, used by the native iOS view only. */
  labelIcon: string;
  backdropUrl: string | null;
  logoUrl: string | null;
  posterUrl: string | null;
  /** Pre-localized "1922", "NR", "1h 34m". */
  badges: string[];
  communityRating: number | null;
  /** Watch progress in 0–1, or null when this is not a resume. */
  progress: number | null;
}

export interface UseHeroItemsOptions {
  /**
   * The width the backdrop will actually render at, so the request matches it
   * (capped at 2x for pixel density) instead of always asking for 1920.
   */
  backdropWidth: number;
}

export interface HeroItems {
  slides: HeroSlide[];
  isLoading: boolean;
  /** Whether the hero should draw anything at all on this platform. */
  isEnabled: boolean;
  /** Keeps the view mounted when a filter, rather than an empty library, emptied it. */
  hasActiveFilters: boolean;
  /** Rows for the native iOS filter menu. */
  filterSections: HeroCarouselFilterSection[];
  /** Applies one menu row by its key. */
  toggleFilter: (key: string) => void;
}

/**
 * The hero's data: what to show, in what order, with every URL and string
 * already resolved.
 *
 * Lifted out of `HomeHeroCarousel.tsx` so the iOS native view and the
 * `HeroSpotlight` that replaces it on web and Android are fed by exactly the
 * same rules — a slide that reads one way on a phone and another way in a
 * browser is a bug nobody would ever find.
 *
 * Two independent filters narrow the slides, both driven by settings and both
 * "hidden" lists so the default (empty) shows everything:
 * `hiddenHomeHeroSections` drops a whole group, `hiddenHomeHeroMediaTypes`
 * drops movies or TV across every group. A group whose content is entirely
 * filtered out is never requested from the server.
 *
 * The hero keeps its length at {@link HERO_TARGET_COUNT} regardless: a
 * filtered-out group's share is reapportioned over whatever remains. Anything
 * still short after that — dedup, a thin library, or a brand-new account with
 * nothing watched at all (F-38) — is backfilled from the buckets that have
 * candidates to spare, which is what makes the hero fall back to "Recently
 * added" rather than rendering empty.
 */
export const useHeroItems = ({
  backdropWidth,
}: UseHeroItemsOptions): HeroItems => {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const { t } = useTranslation();
  const { settings, updateSettings, pluginSettings } = useSettings();

  const hiddenSections = settings?.hiddenHomeHeroSections;
  const hiddenMediaTypes = settings?.hiddenHomeHeroMediaTypes;
  // `settings` starts empty before the stored values load; default to on so
  // the hero doesn't flash out of existence on a cold start.
  const showHeroCarousel = settings?.showHeroCarousel !== false;
  const isEnabled = isHeroAvailable() && showHeroCarousel;

  const filters = useMemo(() => {
    const {
      showMovies,
      showTv,
      showContinueWatching,
      showNextUp,
      showRecentlyAdded,
    } = resolveSources(hiddenSections ?? [], hiddenMediaTypes ?? []);

    // Share out the target length over the groups still standing, then split
    // the recently-added share over the media types still standing.
    const groupQuota = apportion(
      HERO_TARGET_COUNT,
      (
        [
          ["continueWatching", showContinueWatching],
          ["nextUp", showNextUp],
          ["recentlyAdded", showRecentlyAdded],
        ] as [HeroSection, boolean][]
      )
        .filter(([, enabled]) => enabled)
        .map(([section]) => [section, GROUP_WEIGHTS[section]]),
    );

    const mediaQuota = apportion(
      groupQuota.recentlyAdded ?? 0,
      (
        [
          ["movie", showMovies],
          ["tv", showTv],
        ] as [HomeHeroMediaType, boolean][]
      )
        .filter(([, enabled]) => enabled)
        .map(([mediaType]) => [mediaType, 1]),
    );

    return {
      showMovies,
      showTv,
      showContinueWatching,
      showNextUp,
      showRecentlyAddedMovies: showRecentlyAdded && showMovies,
      showRecentlyAddedTv: showRecentlyAdded && showTv,
      continueWatchingQuota: groupQuota.continueWatching ?? 0,
      nextUpQuota: groupQuota.nextUp ?? 0,
      recentlyAddedMovieQuota: mediaQuota.movie ?? 0,
      recentlyAddedTvQuota: mediaQuota.tv ?? 0,
    };
  }, [hiddenSections, hiddenMediaTypes]);

  const { data: entries, isLoading } = useQuery({
    queryKey: [
      "home",
      "heroCarousel",
      user?.Id,
      hiddenSections?.join(",") ?? "",
      hiddenMediaTypes?.join(",") ?? "",
    ],
    queryFn: async (): Promise<HeroEntry[]> => {
      if (!api || !user?.Id) return [];

      const resumeTypes: BaseItemKind[] = [
        ...(filters.showMovies ? (["Movie"] as const) : []),
        ...(filters.showTv ? (["Series", "Episode"] as const) : []),
      ];

      // Each source degrades independently: a failing endpoint drops its
      // slides instead of blanking the whole hero.
      const [resume, nextUp, latestMovies, latestTv] = await Promise.all([
        filters.showContinueWatching
          ? getItemsApi(api)
              .getResumeItems({
                userId: user.Id,
                limit: overFetch(filters.continueWatchingQuota),
                includeItemTypes: resumeTypes,
                fields: ["Overview"],
                enableImageTypes: [...IMAGE_TYPES],
                imageTypeLimit: 1,
              })
              .catch(() => null)
          : null,
        filters.showNextUp
          ? getTvShowsApi(api)
              .getNextUp({
                userId: user.Id,
                limit: overFetch(filters.nextUpQuota),
                fields: ["Overview"],
                enableImageTypes: [...IMAGE_TYPES],
                imageTypeLimit: 1,
                enableResumable: false,
              })
              .catch(() => null)
          : null,
        filters.showRecentlyAddedMovies
          ? getUserLibraryApi(api)
              .getLatestMedia({
                userId: user.Id,
                includeItemTypes: ["Movie"],
                limit: overFetch(filters.recentlyAddedMovieQuota),
                fields: ["Overview"],
                enableImageTypes: [...IMAGE_TYPES],
                imageTypeLimit: 1,
                groupItems: false,
              })
              .catch(() => null)
          : null,
        filters.showRecentlyAddedTv
          ? getUserLibraryApi(api)
              .getLatestMedia({
                userId: user.Id,
                includeItemTypes: ["Series", "Season", "Episode"],
                limit: overFetch(filters.recentlyAddedTvQuota),
                fields: ["Overview"],
                enableImageTypes: [...IMAGE_TYPES],
                imageTypeLimit: 1,
                groupItems: true,
              })
              .catch(() => null)
          : null,
      ]);

      const result: HeroEntry[] = [];
      const seenIds = new Set<string>();
      const seenSeries = new Set<string>();
      const seriesKey = (item: BaseItemDto) =>
        item.SeriesId || (item.Type === "Series" ? item.Id : undefined);

      const push = (
        item: BaseItemDto | null | undefined,
        section: HeroSection,
        requireBackdrop: boolean,
      ): boolean => {
        if (!item?.Id || seenIds.has(item.Id)) return false;
        // A slide is a full-bleed picture with a title over it. An item with
        // no artwork at all has nothing to be, and one with only a poster is
        // a stretched portrait — taken only once the pass that wants a real
        // backdrop has run out of candidates.
        if (backdropSourceOf(item) === null) return false;
        if (requireBackdrop && !hasTrueBackdrop(item)) return false;
        // Endpoints can return a mixed bag (resume covers both kinds), so the
        // media-type filter is enforced on results, not just on the request.
        const mediaType = mediaTypeOf(item);
        if (mediaType === "movie" && !filters.showMovies) return false;
        if (mediaType === "tv" && !filters.showTv) return false;
        // One card per show across the whole hero: with ten slides the same
        // series could otherwise turn up as continue-watching, next-up and
        // recently-added all at once.
        const key = seriesKey(item);
        if (key && seenSeries.has(key)) return false;
        seenIds.add(item.Id);
        if (key) seenSeries.add(key);
        result.push({ item, section });
        return true;
      };

      const buckets = [
        {
          section: "continueWatching" as const,
          candidates: resume?.data.Items ?? [],
          quota: filters.continueWatchingQuota,
        },
        {
          section: "nextUp" as const,
          candidates: nextUp?.data.Items ?? [],
          quota: filters.nextUpQuota,
        },
        {
          section: "recentlyAdded" as const,
          candidates: latestMovies?.data ?? [],
          quota: filters.recentlyAddedMovieQuota,
        },
        {
          section: "recentlyAdded" as const,
          candidates: latestTv?.data ?? [],
          quota: filters.recentlyAddedTvQuota,
        },
      ];

      // Each bucket keeps its own cursor per pass, so the backfill resumes
      // where the quota pass stopped instead of re-testing rejected
      // candidates. The cursors reset for the poster pass, which is looking
      // at a different question.
      const fill = (requireBackdrop: boolean) => {
        const cursors = buckets.map(() => 0);
        const takeFrom = (index: number): boolean => {
          const { candidates, section } = buckets[index];
          while (cursors[index] < candidates.length) {
            const item = candidates[cursors[index]];
            cursors[index] += 1;
            if (push(item, section, requireBackdrop)) return true;
          }
          return false;
        };

        buckets.forEach((bucket, index) => {
          for (let taken = 0; taken < bucket.quota; taken++) {
            if (result.length >= HERO_TARGET_COUNT) return;
            if (!takeFrom(index)) break;
          }
        });

        // Backfill: whatever a bucket couldn't fill (dedup, a thin library, a
        // fresh account with nothing watched) goes to the buckets that still
        // have candidates, round-robin so no single group runs away with the
        // remainder. This is what makes a brand-new account open on
        // "Recently added" instead of on an empty hero (F-38).
        let progressed = true;
        while (result.length < HERO_TARGET_COUNT && progressed) {
          progressed = false;
          for (let index = 0; index < buckets.length; index++) {
            if (result.length >= HERO_TARGET_COUNT) break;
            if (takeFrom(index)) progressed = true;
          }
        }
      };

      fill(true);
      // Only if a real backdrop could not be found anywhere: better a
      // stretched poster than an empty hero.
      if (result.length === 0) fill(false);

      // Backfilled slides are appended wherever they were found, which can
      // strand e.g. a continue-watching card after the recently-added run.
      // Sorting is stable, so this regroups them without disturbing the
      // order within a group.
      result.sort(
        (a, b) =>
          ALL_SECTIONS.indexOf(a.section) - ALL_SECTIONS.indexOf(b.section),
      );

      return result;
    },
    enabled: isEnabled && !!api && !!user?.Id,
    staleTime: 60 * 1000,
  });

  const slides = useMemo<HeroSlide[]>(() => {
    if (!api || !entries) return [];
    return entries.map(({ item, section }) => ({
      id: item.Id as string,
      item,
      section,
      title: (isTvChild(item) ? item.SeriesName : item.Name) || item.Name || "",
      subtitle: buildSubtitle(item),
      overview: item.Overview || "",
      label: t(SECTION_LABEL_KEYS[section]),
      labelIcon: SECTION_ICONS[section],
      backdropUrl: buildBackdropUrl(api, item, backdropWidth),
      logoUrl: buildLogoUrl(api, item),
      posterUrl: buildPosterUrl(api, item),
      badges: buildBadges(item),
      communityRating: item.CommunityRating ?? null,
      progress: item.UserData?.PlayedPercentage
        ? item.UserData.PlayedPercentage / 100
        : null,
    }));
  }, [api, entries, t, backdropWidth]);

  // An admin-locked setting is dropped by updateSettings, so offering its row
  // would just be a dead tap. Omit those rows the way the settings screen
  // disables their switches; with all three locked the button disappears.
  const filterSections = useMemo<HeroCarouselFilterSection[]>(() => {
    const sections: HeroCarouselFilterSection[] = [];
    if (pluginSettings?.hiddenHomeHeroSections?.locked !== true) {
      sections.push({
        key: "groups",
        title: t("home.hero.groups"),
        options: ALL_SECTIONS.map((section) => ({
          key: `${SECTION_KEY_PREFIX}${section}`,
          label: t(SECTION_MENU_KEYS[section]),
          enabled: !(hiddenSections ?? []).includes(section),
        })),
      });
    }
    if (pluginSettings?.hiddenHomeHeroMediaTypes?.locked !== true) {
      sections.push({
        key: "media",
        title: t("home.hero.media"),
        options: ALL_MEDIA_TYPES.map((mediaType) => ({
          key: `${MEDIA_KEY_PREFIX}${mediaType}`,
          label: t(MEDIA_LABEL_KEYS[mediaType]),
          enabled: !(hiddenMediaTypes ?? []).includes(mediaType),
        })),
      });
    }
    if (pluginSettings?.showHeroCarousel?.locked !== true) {
      sections.push({
        // Untitled trailing group: this switches the hero off entirely
        // rather than filtering it, so it reads as its own thing.
        key: "visibility",
        options: [
          {
            key: VISIBILITY_KEY,
            label: t("home.hero.disable"),
            // Only reachable while the hero is on, so it is a one-way
            // action rather than something that can show a checkmark.
            enabled: true,
            destructive: true,
          },
        ],
      });
    }
    return sections;
  }, [t, hiddenSections, hiddenMediaTypes, pluginSettings]);

  const toggleFilter = useCallback(
    (key: string) => {
      if (key === VISIBILITY_KEY) {
        // The row only ever shows checked — the hero is gone once it is off,
        // so the way back is the appearance settings screen.
        updateSettings({ showHeroCarousel: false });
        return;
      }
      if (key.startsWith(SECTION_KEY_PREFIX)) {
        const section = key.slice(SECTION_KEY_PREFIX.length) as HomeHeroSection;
        const next = toggleHidden(hiddenSections ?? [], section);
        if (!hasAnySource(next, hiddenMediaTypes ?? [])) return;
        updateSettings({ hiddenHomeHeroSections: next });
        return;
      }
      if (key.startsWith(MEDIA_KEY_PREFIX)) {
        const mediaType = key.slice(
          MEDIA_KEY_PREFIX.length,
        ) as HomeHeroMediaType;
        const next = toggleHidden(hiddenMediaTypes ?? [], mediaType);
        if (!hasAnySource(hiddenSections ?? [], next)) return;
        updateSettings({ hiddenHomeHeroMediaTypes: next });
      }
    },
    [hiddenSections, hiddenMediaTypes, updateSettings],
  );

  return {
    slides,
    // A disabled hero is not "still loading" — it is never going to draw, and
    // reporting otherwise leaves a skeleton on the page for ever.
    isLoading: isEnabled && isLoading,
    isEnabled,
    hasActiveFilters:
      (hiddenSections?.length ?? 0) > 0 || (hiddenMediaTypes?.length ?? 0) > 0,
    filterSections,
    toggleFilter,
  };
};
