import { describe, expect, mock, test } from "bun:test";
import { stubReactNative } from "@/test-utils/reactNative";

// bun:test cannot load React Native; scaleSize only needs Dimensions, which the
// stub reports as a 1920x1080 window so scaleSize() is the identity here and
// the base values in this file are the numbers under test.
stubReactNative({ isTV: true });

// The settings module is only wanted for the TVTypographyScale enum and the
// hook's reader, but it transitively reaches JellyfinProvider and a codegen'd
// native component, which bun:test cannot parse. Publish the two names these
// constants need; the enum values are the real ones, so the multiplier table
// under test is keyed exactly as it is at runtime. No other spec evaluates the
// real module, so this global mock is inert elsewhere.
mock.module("@/utils/atoms/settings", () => ({
  TVTypographyScale: {
    Small: "small",
    Default: "default",
    Large: "large",
    ExtraLarge: "extraLarge",
  },
  useSettings: () => ({ settings: { tvTypographyScale: "default" } }),
}));

// Imported after the mocks: static ESM imports would evaluate the real modules.
const {
  TV_CARD_SPACING,
  TV_FOCUS,
  TVCardLayouts,
  scaleTVCardLayout,
  tvCardFocusOverflow,
  tvCardRowHeight,
  tvCardScaleMultipliers,
} = await import("./TVCardLayouts");
const { TVGaps, TVLayout, TVPadding, TVPosterSizes } = await import(
  "./TVSizes"
);

type CardKind = keyof typeof TVCardLayouts;
const KINDS = Object.keys(TVCardLayouts) as CardKind[];
const SCALES = Object.values(tvCardScaleMultipliers);

describe("TVCardLayouts", () => {
  test("every shape has positive dimensions", () => {
    for (const kind of KINDS) {
      const base = TVCardLayouts[kind];
      expect(base.cardWidth).toBeGreaterThan(0);
      expect(base.aspectRatio).toBeGreaterThan(0);
      expect(base.borderRadius).toBeGreaterThanOrEqual(0);
      expect(base.titleLines).toBeGreaterThan(0);
      expect(base.subtitleLines).toBeGreaterThanOrEqual(0);
    }
  });

  test("scaling keeps every dimension positive at every typography scale", () => {
    for (const kind of KINDS) {
      for (const scale of SCALES) {
        const layout = scaleTVCardLayout(kind, scale);
        expect(layout.cardWidth).toBeGreaterThan(0);
        expect(layout.cardHeight).toBeGreaterThan(0);
        expect(layout.spacing).toBeGreaterThan(0);
        expect(Number.isFinite(layout.cardHeight)).toBe(true);
      }
    }
  });

  test("card height follows the declared aspect ratio", () => {
    for (const kind of KINDS) {
      const layout = scaleTVCardLayout(kind, 1);
      // Rounded to whole pixels, so allow a pixel of slack.
      expect(
        Math.abs(layout.cardHeight - layout.cardWidth / layout.aspectRatio),
      ).toBeLessThanOrEqual(1);
    }
  });

  test("portrait is taller than wide, and both are wider than a rail tile", () => {
    const portrait = scaleTVCardLayout("portrait", 1);
    const wide = scaleTVCardLayout("wide", 1);
    const rail = scaleTVCardLayout("rail", 1);

    expect(portrait.cardHeight).toBeGreaterThan(portrait.cardWidth);
    expect(wide.cardWidth).toBeGreaterThan(wide.cardHeight);
    expect(portrait.cardWidth).toBeGreaterThan(rail.cardWidth);
    expect(wide.cardWidth).toBeGreaterThan(rail.cardWidth);
  });
});

describe("tvCardRowHeight", () => {
  test("is positive and leaves room for the focus scale", () => {
    for (const kind of KINDS) {
      const layout = scaleTVCardLayout(kind, 1);
      const height = tvCardRowHeight(layout);

      expect(height).toBeGreaterThan(0);
      // A focused card is TV_FOCUS.scale times as tall about its centre, so the
      // row must be at least that tall or the card clips against the parent.
      expect(height).toBeGreaterThanOrEqual(layout.cardHeight * TV_FOCUS.scale);
    }
  });

  test("adds the caller's text block on top", () => {
    const layout = scaleTVCardLayout("portrait", 1);
    expect(tvCardRowHeight(layout, 40) - tvCardRowHeight(layout)).toBe(40);
  });

  test("ignores a negative text height rather than shrinking the row", () => {
    const layout = scaleTVCardLayout("portrait", 1);
    expect(tvCardRowHeight(layout, -100)).toBe(tvCardRowHeight(layout));
  });
});

describe("tvCardFocusOverflow", () => {
  test("is the half-difference the 1.05 scale adds on each side", () => {
    const layout = scaleTVCardLayout("portrait", 1);
    const overflow = tvCardFocusOverflow(layout);

    expect(overflow.horizontal).toBe(
      Math.ceil((layout.cardWidth * (TV_FOCUS.scale - 1)) / 2),
    );
    expect(overflow.vertical).toBe(
      Math.ceil((layout.cardHeight * (TV_FOCUS.scale - 1)) / 2),
    );
    expect(overflow.horizontal).toBeGreaterThan(0);
  });

  test("a focused card fits inside the standard row spacing", () => {
    // Two neighbouring cards are TV_CARD_SPACING apart. The focused one grows
    // by `horizontal` on the side facing its neighbour, so the gap has to cover
    // it or focused cards visibly overlap their unfocused neighbours.
    for (const kind of KINDS) {
      const layout = scaleTVCardLayout(kind, 1);
      expect(tvCardFocusOverflow(layout).horizontal).toBeLessThanOrEqual(
        layout.spacing,
      );
    }
  });
});

describe("TV_FOCUS", () => {
  test("focus is white, never the accent", () => {
    expect(TV_FOCUS.borderColor).toBe("#FFFFFF");
  });

  test("scale is a growth, and the glow is a hint rather than a halo", () => {
    expect(TV_FOCUS.scale).toBeGreaterThan(1);
    expect(TV_FOCUS.durationMs).toBeGreaterThan(0);
    expect(TV_FOCUS.glowOpacity).toBeGreaterThan(0);
    expect(TV_FOCUS.glowOpacity).toBeLessThan(1);
  });
});

describe("TVSizes is re-expressed on the card shapes", () => {
  test("poster sizes come from the card widths", () => {
    expect(TVPosterSizes.poster).toBe(TVCardLayouts.portrait.cardWidth);
    expect(TVPosterSizes.landscape).toBe(TVCardLayouts.wide.cardWidth);
    expect(TVPosterSizes.episode).toBe(TVCardLayouts.episode.cardWidth);
  });

  test("the row gap is the card spacing", () => {
    expect(TVGaps.item).toBe(TV_CARD_SPACING);
  });
});

describe("TVLayout", () => {
  test("content starts clear of the collapsed rail", () => {
    expect(TVLayout.contentInsetLeft).toBeGreaterThan(
      TVLayout.railCollapsedWidth,
    );
    expect(TVLayout.contentInsetLeft).toBe(
      TVLayout.railCollapsedWidth + TVPadding.horizontal,
    );
  });

  test("the rail expands, and its scrim reaches past the expansion", () => {
    expect(TVLayout.railExpandedWidth).toBeGreaterThan(
      TVLayout.railCollapsedWidth,
    );
    expect(TVLayout.railScrimWidth).toBeGreaterThanOrEqual(
      TVLayout.railExpandedWidth,
    );
  });

  test("the collapsed rail is the rail card shape", () => {
    expect(TVLayout.railCollapsedWidth).toBe(TVCardLayouts.rail.cardWidth);
  });
});
