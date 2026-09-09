import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Platform, useWindowDimensions } from "react-native";
import useRouter from "@/hooks/useAppRouter";
import { useHaptic } from "@/hooks/useHaptic";
import { useHeroItems } from "@/hooks/useHeroItems";
import {
  type HeroCarouselItem,
  type HeroCarouselItemPressEvent,
  HeroCarouselView,
  isHeroCarouselAvailable,
} from "@/modules";
import { getItemNavigation } from "../common/TouchableItemRouter";
import { HeroSpotlight } from "./HeroSpotlight";

// Space the native view reserves under the cards for the page dots.
const DOTS_AREA = 24;

/**
 * Card geometry for the current window width. Derived per render rather than
 * once at import: on iPad the width changes with rotation and Split View.
 */
const heroMetrics = (windowWidth: number) => {
  // Matches the 36pt page margin inside the native view.
  const cardWidth = Math.max(windowWidth - 72, 1);
  return {
    cardHeight: Math.round(Math.min(cardWidth * 1.15, 440)),
    backdropWidth: Math.min(Math.round(cardWidth * 2), 1920),
  };
};

/**
 * The hero at the top of the home tab — whichever hero this platform has.
 *
 * iOS keeps the native SwiftUI carousel: it is a genuinely better thing on a
 * phone (interactive parallax, glass info panels) and there is no reason to
 * replace working native code with a JS approximation of it. Everywhere else
 * — the browser, Android — renders `HeroSpotlight`, which is why a 1440 px
 * window no longer opens on a bare row of posters.
 *
 * Both are fed by `useHeroItems`, so "what is worth spotlighting" is decided
 * in exactly one place. This file is only the switch and the native view's
 * presentational plumbing: the native side takes prebuilt image URLs and
 * localized strings and hands back item ids.
 */
export const HomeHeroCarousel = () => {
  const router = useRouter();
  const { t } = useTranslation();
  const lightHapticFeedback = useHaptic("light");
  const { width: windowWidth } = useWindowDimensions();
  const metrics = useMemo(() => heroMetrics(windowWidth), [windowWidth]);

  // Hooks cannot be called conditionally, so the switch happens on the way
  // out. The native branch is the only one that reads any of this.
  const useNativeView = !Platform.isTV && isHeroCarouselAvailable();

  const { slides, isEnabled, hasActiveFilters, filterSections, toggleFilter } =
    useHeroItems({ backdropWidth: metrics.backdropWidth });

  const items = useMemo<HeroCarouselItem[]>(
    () =>
      slides.map((slide) => ({
        id: slide.id,
        title: slide.title,
        subtitle: slide.subtitle,
        overview: slide.overview,
        label: slide.label,
        labelIcon: slide.labelIcon,
        backdropUrl: slide.backdropUrl,
        logoUrl: slide.logoUrl,
        posterUrl: slide.posterUrl,
        badges: slide.badges,
        communityRating: slide.communityRating,
        progress: slide.progress,
      })),
    [slides],
  );

  const handleFilterToggle = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      lightHapticFeedback();
      toggleFilter(event.nativeEvent.key);
    },
    [toggleFilter, lightHapticFeedback],
  );

  const handleItemPress = useCallback(
    (event: { nativeEvent: HeroCarouselItemPressEvent }) => {
      const slide = slides.find(({ id }) => id === event.nativeEvent.id);
      if (!slide) return;
      lightHapticFeedback();
      router.push(getItemNavigation(slide.item, "(home)") as never);
    },
    [slides, router, lightHapticFeedback],
  );

  if (!isEnabled) return null;

  if (!useNativeView) return <HeroSpotlight />;

  // Keep the view mounted when filters emptied it, so the filter button (and
  // the way back) stays reachable over the empty-state skeleton.
  if (items.length === 0 && !hasActiveFilters) return null;

  return (
    <HeroCarouselView
      items={items}
      filterSections={filterSections}
      filterLabel={t("home.hero.filter")}
      onItemPress={handleItemPress}
      onFilterToggle={handleFilterToggle}
      style={{
        width: "100%",
        height: metrics.cardHeight + DOTS_AREA,
        marginTop: 8,
      }}
    />
  );
};
