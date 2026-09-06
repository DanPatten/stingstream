import { describe, expect, test } from "bun:test";
import { breakpoints } from "@/constants/theme";
import { stubReactNative } from "@/test-utils/reactNative";

// `CardData.ts` pulls in `components/common/ProgressBar.tsx` for
// `getItemProgressPercentage`, which imports react-native at module scope —
// `bun:test` cannot load the real module, so it has to be stubbed before
// anything transitively requires it. Everything under test here is plain
// arithmetic; the stub is only load-bearing for the import chain.
stubReactNative();

const {
  autoGridColumns,
  CARD_LAYOUTS,
  cardRowHeight,
}: typeof import("./CardData") = await import("./CardData");
type CardKind = import("./CardData").CardKind;
type ResolvedCardLayout = import("./CardData").ResolvedCardLayout;

const KINDS: CardKind[] = ["wide", "portrait", "rowWide"];
const BREAKPOINTS = ["compact", "medium", "expanded"] as const;

/** The five widths the plan's own spec calls out for this test. */
const TEST_WIDTHS = [390, 768, 1024, 1440, 2560];

/**
 * The same width -> band rule as `hooks/useBreakpoint.ts`'s `breakpointFor`,
 * reproduced rather than imported: that module touches `react-native`'s
 * `Dimensions` at import time, which `bun:test` cannot load un-mocked, and
 * this file is otherwise pure arithmetic with nothing to stub for.
 */
const breakpointFor = (width: number): (typeof BREAKPOINTS)[number] => {
  if (width >= breakpoints.expanded) return "expanded";
  if (width >= breakpoints.medium) return "medium";
  return "compact";
};

// ---------------------------------------------------------------------------
// Widths per breakpoint
// ---------------------------------------------------------------------------

describe("CARD_LAYOUTS widths", () => {
  test("the exact card widths the plan specifies", () => {
    expect(CARD_LAYOUTS.portrait.cardWidth).toEqual({
      compact: 118,
      medium: 150,
      expanded: 170,
    });
    expect(CARD_LAYOUTS.wide.cardWidth).toEqual({
      compact: 200,
      medium: 260,
      expanded: 300,
    });
    expect(CARD_LAYOUTS.rowWide.cardWidth).toEqual({
      compact: 128,
      medium: 144,
      expanded: 160,
    });
  });

  test("the exact grid minimum the plan specifies, for every kind", () => {
    for (const kind of KINDS) {
      expect(CARD_LAYOUTS[kind].gridMinCardWidth).toEqual({
        compact: 110,
        medium: 140,
        expanded: 160,
      });
    }
  });

  test("cardWidth never shrinks as the breakpoint widens", () => {
    for (const kind of KINDS) {
      const { compact, medium, expanded } = CARD_LAYOUTS[kind].cardWidth;
      expect(compact).toBeLessThanOrEqual(medium);
      expect(medium).toBeLessThanOrEqual(expanded);
    }
  });

  test("gridMinCardWidth never shrinks as the breakpoint widens", () => {
    for (const kind of KINDS) {
      const { compact, medium, expanded } = CARD_LAYOUTS[kind].gridMinCardWidth;
      expect(compact).toBeLessThanOrEqual(medium);
      expect(medium).toBeLessThanOrEqual(expanded);
    }
  });
});

// ---------------------------------------------------------------------------
// Auto-column formula (useCardGrid, when the caller omits `columns`)
// ---------------------------------------------------------------------------

describe("autoGridColumns", () => {
  test("matches the CSS-grid auto-fill formula directly", () => {
    // repeat(auto-fill, minmax(110, 1fr)) over 1000px of room, 10px gaps.
    expect(autoGridColumns(1000, 110, 10)).toBe(
      Math.floor((1000 + 10) / (110 + 10)),
    );
  });

  test("never returns fewer than one column, even narrower than the minimum", () => {
    expect(autoGridColumns(50, 110, 10)).toBe(1);
    expect(autoGridColumns(0, 110, 10)).toBe(1);
  });

  test("is monotonic: more available width never yields fewer columns", () => {
    // This is the general property bug 4 violated — a hard-coded switch whose
    // branches disagreed with each other returned *fewer* columns at a wider
    // screenWidth (6 at >= 1500px vs. 7 at 1000-1500px). A formula derived
    // from one rule cannot do that.
    let previous = autoGridColumns(300, 140, 10);
    for (let width = 320; width <= 3000; width += 20) {
      const columns = autoGridColumns(width, 140, 10);
      expect(columns).toBeGreaterThanOrEqual(previous);
      previous = columns;
    }
  });

  test("the fixed 6-vs-7 regression bug 4 named no longer reproduces", () => {
    // The old [libraryId].tsx switch: 7 columns for 1000-1500px, 6 columns at
    // >= 1500px. Reproduced here against portrait's own numbers so a future
    // edit to the min-width table can't silently reintroduce the same shape.
    const { gridMinCardWidth, spacing, contentInset } = CARD_LAYOUTS.portrait;
    const available = (width: number) => width - contentInset * 2;
    const columnsAt = (width: number) => {
      const breakpoint = breakpointFor(width);
      return autoGridColumns(
        available(width),
        gridMinCardWidth[breakpoint],
        spacing,
      );
    };
    expect(columnsAt(1400)).toBeLessThanOrEqual(columnsAt(1600));
  });

  describe("at each of the plan's test widths", () => {
    for (const width of TEST_WIDTHS) {
      test(`${width}px picks a sensible column count for a portrait grid`, () => {
        const { gridMinCardWidth, spacing, contentInset } =
          CARD_LAYOUTS.portrait;
        const breakpoint = breakpointFor(width);
        const min = gridMinCardWidth[breakpoint];
        const available = width - contentInset * 2;
        const columns = autoGridColumns(available, min, spacing);

        expect(columns).toBe(
          Math.max(1, Math.floor((available + spacing) / (min + spacing))),
        );
        expect(columns).toBeGreaterThanOrEqual(1);
        // Every column has to be at least as wide as the minimum it was
        // solved for — otherwise the formula overpacked the row.
        const cardWidth = Math.floor(
          (available - spacing * (columns - 1)) / columns,
        );
        expect(cardWidth).toBeGreaterThanOrEqual(min);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Row height
// ---------------------------------------------------------------------------

describe("cardRowHeight", () => {
  const resolve = (
    kind: CardKind,
    breakpoint: (typeof BREAKPOINTS)[number],
  ) => {
    const layout = CARD_LAYOUTS[kind];
    const resolved: ResolvedCardLayout = {
      ...layout,
      cardWidth: layout.cardWidth[breakpoint],
      gridMinCardWidth: layout.gridMinCardWidth[breakpoint],
    };
    return resolved;
  };

  test("computes height from the resolved width and the kind's aspect ratio", () => {
    for (const kind of KINDS) {
      for (const breakpoint of BREAKPOINTS) {
        const layout = resolve(kind, breakpoint);
        const height = cardRowHeight(layout);
        expect(height).toBeCloseTo(
          layout.cardWidth / layout.aspectRatio + layout.verticalPadding * 2,
        );
      }
    }
  });

  test("a wide row is shorter than a portrait row at the same width class", () => {
    // Sanity check on the aspect ratios themselves: landscape stills read
    // wider than they are tall, posters the opposite.
    for (const breakpoint of BREAKPOINTS) {
      const wide = cardRowHeight(resolve("wide", breakpoint));
      const portrait = cardRowHeight(resolve("portrait", breakpoint));
      expect(wide).toBeLessThan(portrait);
    }
  });

  test("grows with the breakpoint, following its own card width", () => {
    for (const kind of KINDS) {
      const heights = BREAKPOINTS.map((b) => cardRowHeight(resolve(kind, b)));
      expect(heights).toEqual([...heights].sort((a, b) => a - b));
    }
  });
});
