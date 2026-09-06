import { TVTypographyScale, useSettings } from "@/utils/atoms/settings";
import { scaleSize } from "@/utils/scaleSize";

/**
 * TV card geometry, in one place.
 *
 * Every focusable card on a television is one of five shapes. Before this file
 * each screen invented its own width, radius and gap, so a poster in a Home row
 * and the same poster in a library grid were different sizes and the rows never
 * lined up. A card kind now names a shape; a screen picks a kind and asks for
 * the scaled numbers.
 *
 * Base values are authored for 1920x1080 and go through `scaleSize()` for the
 * real viewport, then through the user's `tvTypographyScale` multiplier — the
 * same two-step scaling `TVSizes` and `TVTypography` use, so text and the cards
 * it sits under grow together.
 */

// =============================================================================
// SHAPES
// =============================================================================

export type TVCardKind = "portrait" | "wide" | "episode" | "hero" | "rail";

export interface TVCardLayout {
  /** Card width in base (1920x1080) pixels. */
  cardWidth: number;
  /** width / height. */
  aspectRatio: number;
  /** Corner radius in base pixels. */
  borderRadius: number;
  /** Lines the title is allowed before it truncates. */
  titleLines: number;
  /** Lines the subtitle is allowed. 0 means the shape carries no subtitle. */
  subtitleLines: number;
}

export const TVCardLayouts: Record<TVCardKind, TVCardLayout> = {
  /** Movies and series. The default browse shape. */
  portrait: {
    cardWidth: 300,
    aspectRatio: 10 / 15,
    borderRadius: 24,
    titleLines: 2,
    subtitleLines: 1,
  },
  /** Landscape artwork: continue watching, thumbs, channel rows. */
  wide: {
    cardWidth: 470,
    aspectRatio: 16 / 9,
    borderRadius: 24,
    titleLines: 1,
    subtitleLines: 1,
  },
  /** Episode cards. Narrower than `wide` so more of a season fits on screen. */
  episode: {
    cardWidth: 440,
    aspectRatio: 16 / 9,
    borderRadius: 24,
    titleLines: 2,
    subtitleLines: 1,
  },
  /** The spotlight thumbnail strip under the Home hero. */
  hero: {
    cardWidth: 440,
    aspectRatio: 16 / 9,
    borderRadius: 24,
    titleLines: 1,
    subtitleLines: 0,
  },
  /** Square tiles: the navigation rail's icon wells, playlists, artists. */
  rail: {
    cardWidth: 96,
    aspectRatio: 1,
    borderRadius: 16,
    titleLines: 1,
    subtitleLines: 0,
  },
};

/** Gap between two cards in a row, and between two rows. Base pixels. */
export const TV_CARD_SPACING = 24;

/**
 * The one focus treatment on TV.
 *
 * White, never the accent: the accent is a brand colour and reads as "selected"
 * rather than "focused" from across a room, and `docs/conventions/tv.md` has
 * banned a coloured focus ring since the first TV pass.
 */
export const TV_FOCUS = {
  scale: 1.05,
  durationMs: 150,
  borderWidth: 2,
  borderColor: "#FFFFFF",
  glowOpacity: 0.3,
  glowRadius: 12,
} as const;

// =============================================================================
// SCALING
// =============================================================================

/**
 * Same multipliers `TVSizes` uses for posters and gaps. Kept in this file too
 * rather than imported, so a card can be sized without pulling in the whole
 * sizes module — and so the two cannot drift apart silently, since
 * `TVCardLayouts.test.ts` asserts they agree.
 */
export const tvCardScaleMultipliers: Record<TVTypographyScale, number> = {
  [TVTypographyScale.Small]: 0.53,
  [TVTypographyScale.Default]: 0.63,
  [TVTypographyScale.Large]: 0.77,
  [TVTypographyScale.ExtraLarge]: 0.84,
};

export interface ScaledTVCardLayout {
  kind: TVCardKind;
  /** Rendered card width, in device pixels. */
  cardWidth: number;
  /** Rendered card height, derived from the aspect ratio. */
  cardHeight: number;
  aspectRatio: number;
  borderRadius: number;
  /** Gap to the next card, and to the next row. */
  spacing: number;
  titleLines: number;
  subtitleLines: number;
}

/** Pure form of `useScaledTVCardLayout`, for tests and non-React callers. */
export const scaleTVCardLayout = (
  kind: TVCardKind,
  scale: number,
): ScaledTVCardLayout => {
  const base = TVCardLayouts[kind];
  const cardWidth = Math.round(scaleSize(base.cardWidth) * scale);

  return {
    kind,
    cardWidth,
    cardHeight: Math.round(cardWidth / base.aspectRatio),
    aspectRatio: base.aspectRatio,
    borderRadius: Math.round(scaleSize(base.borderRadius) * scale),
    spacing: Math.round(scaleSize(TV_CARD_SPACING) * scale),
    titleLines: base.titleLines,
    subtitleLines: base.subtitleLines,
  };
};

/**
 * The scaled geometry for one card shape.
 *
 * @example
 * const card = useScaledTVCardLayout("portrait");
 * <View style={{ width: card.cardWidth, aspectRatio: card.aspectRatio }} />
 */
export const useScaledTVCardLayout = (kind: TVCardKind): ScaledTVCardLayout => {
  const { settings } = useSettings();
  const scale =
    tvCardScaleMultipliers[settings.tvTypographyScale] ??
    tvCardScaleMultipliers[TVTypographyScale.Default];

  return scaleTVCardLayout(kind, scale);
};

// =============================================================================
// DERIVED GEOMETRY
// =============================================================================

/**
 * Pixels a focused card claims beyond its own box, on each side.
 *
 * A focused card scales by `TV_FOCUS.scale` about its centre, so it grows by
 * half the difference in every direction. A row that pads by less than this
 * clips the focused card against its parent — the single most common TV layout
 * bug in this codebase, and the reason `overflow: "visible"` is a rule.
 */
export const tvCardFocusOverflow = (
  layout: ScaledTVCardLayout,
): { horizontal: number; vertical: number } => ({
  horizontal: Math.ceil((layout.cardWidth * (TV_FOCUS.scale - 1)) / 2),
  vertical: Math.ceil((layout.cardHeight * (TV_FOCUS.scale - 1)) / 2),
});

/**
 * Height one row of these cards needs, focus headroom included.
 *
 * `textHeight` is whatever the caller renders under the card (a title, a
 * subtitle, both, or nothing). Skeletons call this with the same arguments as
 * the real row so the placeholder does not resize when content arrives.
 */
export const tvCardRowHeight = (
  layout: ScaledTVCardLayout,
  textHeight = 0,
): number =>
  layout.cardHeight +
  tvCardFocusOverflow(layout).vertical * 2 +
  Math.max(0, textHeight);
