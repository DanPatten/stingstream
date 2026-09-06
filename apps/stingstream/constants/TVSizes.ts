import {
  TV_CARD_SPACING,
  TV_FOCUS,
  TVCardLayouts,
  tvCardScaleMultipliers,
} from "@/constants/TVCardLayouts";
import { TVTypographyScale, useSettings } from "@/utils/atoms/settings";
import { scaleSize } from "@/utils/scaleSize";

/**
 * TV Layout Sizes
 *
 * Unified constants for TV interface layout including posters, gaps, and padding.
 * Base values are designed for 1920x1080 and scaled to the actual viewport via
 * scaleSize(), then further adjusted by the user's tvTypographyScale setting.
 *
 * The card shapes themselves live in `TVCardLayouts.ts`; this file re-expresses
 * them under their older names and adds the page-level geometry (the navigation
 * rail's footprint, the single content inset every screen owes it).
 */

// =============================================================================
// BASE VALUES (at Default scale)
// =============================================================================

/**
 * Base poster widths in pixels, taken from the card shapes so a poster is the
 * same size whichever module asked for it. Heights come from the aspect ratios.
 */
export const TVPosterSizes = {
  /** Portrait posters (movies, series) - 10:15 aspect ratio */
  poster: TVCardLayouts.portrait.cardWidth,

  /** Landscape posters (continue watching, thumbs, hero) - 16:9 aspect ratio */
  landscape: TVCardLayouts.wide.cardWidth,

  /** Episode cards - 16:9 aspect ratio */
  episode: TVCardLayouts.episode.cardWidth,
} as const;

/**
 * Base gap/spacing values in pixels.
 */
export const TVGaps = {
  /** Gap between items in horizontal lists */
  item: TV_CARD_SPACING,

  /** Gap between sections vertically */
  section: 32,

  /** Small gap for tight layouts */
  small: 12,

  /** Large gap for spacious layouts */
  large: 48,
} as const;

/**
 * Base padding values in pixels.
 */
export const TVPadding = {
  /**
   * The one horizontal padding on TV.
   *
   * There used to be three — 60 in the library grid, 80 in the home rows,
   * scaleSize(80) on the details page — which is why nothing on a TV screen
   * ever lined up with anything on the screen before it. Every TV surface now
   * pads by this on the right and by `TVLayout.contentInsetLeft` on the left,
   * where the navigation rail lives.
   */
  horizontal: 80,

  /** Padding to accommodate scale animations (1.05x) */
  scale: 20,

  /** Vertical padding for content areas */
  vertical: 24,

  /** Hero section height as percentage of screen height (0.0 - 1.0) */
  heroHeight: 0.6,
} as const;

/**
 * The navigation rail's footprint, and what it costs every other screen.
 *
 * The rail is an absolute overlay pinned to the left edge (the same trick the
 * old top nav bar used), so screens do not lose layout width to it — they owe
 * it a left inset instead. One constant, `contentInsetLeft`, is that debt.
 */
export const TVLayout = {
  /** Rail width at rest: an icon well plus its breathing room. */
  railCollapsedWidth: TVCardLayouts.rail.cardWidth,

  /** Rail width once anything inside it takes focus, revealing the labels. */
  railExpandedWidth: 288,

  /**
   * How far the darkening scrim reaches past the collapsed rail. Content keeps
   * scrolling under it; the gradient is what makes white-on-poster labels
   * legible without a hard edge.
   */
  railScrimWidth: 320,

  /**
   * Left inset every TV screen starts its content at: the collapsed rail plus
   * the standard gutter. Nothing focusable may sit left of this, or the rail
   * covers it.
   */
  contentInsetLeft: TVCardLayouts.rail.cardWidth + TVPadding.horizontal,

  /**
   * The single small top inset. There is no top bar any more, so screens no
   * longer reserve 100–145 px for one; this is just the overscan margin.
   */
  contentInsetTop: 48,
} as const;

/**
 * Animation and interaction values.
 */
export const TVAnimation = {
  /** Scale factor for focused items */
  focusScale: TV_FOCUS.scale,

  /** How long a focus scale takes. */
  focusDurationMs: TV_FOCUS.durationMs,

  /**
   * How long a focus move must settle before the backdrop follows it.
   *
   * Held in one place because Home and the hero carousel each had their own
   * copy of 300, and a divergence between them makes the backdrop change twice
   * on a single D-pad press.
   */
  backdropDebounceMs: 300,

  /** Backdrop crossfade duration. */
  crossfadeMs: 500,

  /** Rail collapse/expand duration. Matches the focus scale so they read as one move. */
  railExpandMs: 150,
} as const;

// =============================================================================
// SCALING
// =============================================================================

/**
 * Scale multipliers for each typography scale level.
 * Applied to poster sizes and gaps. Shared with `TVCardLayouts` so a card and
 * the row it sits in cannot scale differently.
 */
const sizeScaleMultipliers: Record<TVTypographyScale, number> =
  tvCardScaleMultipliers;

// =============================================================================
// HOOKS
// =============================================================================

export type ScaledTVPosterSizes = {
  poster: number;
  landscape: number;
  episode: number;
};

export type ScaledTVGaps = {
  item: number;
  section: number;
  small: number;
  large: number;
};

export type ScaledTVPadding = {
  horizontal: number;
  scale: number;
  vertical: number;
  heroHeight: number;
};

export type ScaledTVLayout = {
  railCollapsedWidth: number;
  railExpandedWidth: number;
  railScrimWidth: number;
  contentInsetLeft: number;
  contentInsetTop: number;
};

export type ScaledTVSizes = {
  posters: ScaledTVPosterSizes;
  gaps: ScaledTVGaps;
  padding: ScaledTVPadding;
  layout: ScaledTVLayout;
  animation: typeof TVAnimation;
};

/**
 * Hook that returns all scaled TV sizes based on user settings.
 *
 * @example
 * const sizes = useScaledTVSizes();
 * <View style={{ width: sizes.posters.poster, marginRight: sizes.gaps.item }}>
 */
export const useScaledTVSizes = (): ScaledTVSizes => {
  const { settings } = useSettings();
  const scale =
    sizeScaleMultipliers[settings.tvTypographyScale] ??
    sizeScaleMultipliers[TVTypographyScale.Default];

  // Chrome, unlike content, does not grow with the typography scale: a rail
  // that widened with the text setting would eat the screen at Extra Large.
  const railCollapsedWidth = Math.round(scaleSize(TVLayout.railCollapsedWidth));

  return {
    posters: {
      poster: Math.round(scaleSize(TVPosterSizes.poster) * scale),
      landscape: Math.round(scaleSize(TVPosterSizes.landscape) * scale),
      episode: Math.round(scaleSize(TVPosterSizes.episode) * scale),
    },
    gaps: {
      item: Math.round(scaleSize(TVGaps.item) * scale),
      section: Math.round(scaleSize(TVGaps.section) * scale),
      small: Math.round(scaleSize(TVGaps.small) * scale),
      large: Math.round(scaleSize(TVGaps.large) * scale),
    },
    padding: {
      // Static: matches the native tvOS search bar inset, which is a fixed
      // point value and does not change with the typography scale setting.
      horizontal: TVPadding.horizontal,
      scale: Math.round(scaleSize(TVPadding.scale) * scale),
      vertical: Math.round(scaleSize(TVPadding.vertical) * scale),
      heroHeight: TVPadding.heroHeight * scale,
    },
    layout: {
      railCollapsedWidth,
      railExpandedWidth: Math.round(scaleSize(TVLayout.railExpandedWidth)),
      railScrimWidth: Math.round(scaleSize(TVLayout.railScrimWidth)),
      contentInsetLeft: railCollapsedWidth + TVPadding.horizontal,
      contentInsetTop: Math.round(scaleSize(TVLayout.contentInsetTop)),
    },
    animation: TVAnimation,
  };
};

/**
 * Hook that returns only scaled poster sizes.
 * Use this for backwards compatibility or when you only need poster sizes.
 */
export const useScaledTVPosterSizes = (): ScaledTVPosterSizes => {
  const sizes = useScaledTVSizes();
  return sizes.posters;
};

/**
 * Hook that returns only scaled gap sizes.
 */
export const useScaledTVGaps = (): ScaledTVGaps => {
  const sizes = useScaledTVSizes();
  return sizes.gaps;
};

/**
 * Hook that returns only scaled padding sizes.
 */
export const useScaledTVPadding = (): ScaledTVPadding => {
  const sizes = useScaledTVSizes();
  return sizes.padding;
};

/**
 * Hook that returns only the page-level layout numbers (rail width, insets).
 */
export const useScaledTVLayout = (): ScaledTVLayout => {
  const sizes = useScaledTVSizes();
  return sizes.layout;
};
