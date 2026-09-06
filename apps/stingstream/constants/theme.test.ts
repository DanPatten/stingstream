import { describe, expect, test } from "bun:test";
import {
  ACCENT_NAMES,
  accentPalette,
  type BreakpointName,
  DEFAULT_ACCENT,
  elevation,
  resolveTextStyle,
  rgba,
  type TypeVariant,
  tokens,
  typeStyle,
} from "./theme";

// The design system's two promises, pinned:
//
//  1. Text is readable. Dark-only UIs drift towards grey-on-grey one commit at
//     a time, and nobody notices until a screenshot review. The ratios below
//     are the plan's own targets, computed the way WCAG computes them.
//  2. Tailwind and `theme.ts` cannot disagree, because both read the same JSON
//     — and the second test proves the JSON actually reached the Tailwind
//     extend rather than being half-wired.

const tailwind = require("../tailwind.config.js");
const extend = tailwind.theme.extend;

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string) => {
  const int = Number.parseInt(hex.replace("#", ""), 16);
  return (
    0.2126 * channel((int >> 16) & 255) +
    0.7152 * channel((int >> 8) & 255) +
    0.0722 * channel(int & 255)
  );
};

/** WCAG 2.x contrast ratio, 1:1 (identical) to 21:1 (black on white). */
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

describe("contrast", () => {
  test("the ratio helper agrees with the known endpoints", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  test("secondary text on a card reaches AA", () => {
    // Card, list-group and sidebar backgrounds are bg1; secondary is the
    // subtitle under every row title.
    expect(
      contrast(tokens.color.text.secondary, tokens.color.bg["1"]),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("primary text on an input reaches AAA", () => {
    expect(
      contrast(tokens.color.text.primary, tokens.color.bg["2"]),
    ).toBeGreaterThanOrEqual(7);
  });

  test("primary text reaches AAA on every surface", () => {
    for (const [name, background] of Object.entries(tokens.color.bg)) {
      expect({
        surface: `bg${name}`,
        ratio: contrast(tokens.color.text.primary, background) >= 7,
      }).toEqual({ surface: `bg${name}`, ratio: true });
    }
  });

  test("on-accent text reaches AAA on teal and amber", () => {
    // These two carry the dark `onAccent`: white on either is about 2:1.
    for (const name of ["teal", "amber"] as const) {
      const palette = accentPalette(name);
      expect({
        accent: name,
        ratio: contrast(palette.onAccent, palette[500]) >= 7,
      }).toEqual({ accent: name, ratio: true });
    }
  });

  test("violet is held to AA, because AAA is unreachable on it", () => {
    // #9334E9 is the fork's legacy purple, kept as a selectable accent. Its
    // best possible foreground is white at 5.4:1 — no colour reaches 7:1
    // against it — so the plan's AAA target cannot hold for violet without
    // changing the hex. Teal is the default and the brand colour; violet is an
    // opt-in preference, so it is held to AA instead. Raise this to 7 only
    // together with a darker violet-500.
    const palette = accentPalette("violet");
    expect(contrast(palette.onAccent, palette[500])).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast("#FFFFFF", palette[500])).toBeLessThan(7);
  });

  test("danger text is readable on every surface", () => {
    for (const background of Object.values(tokens.color.bg)) {
      expect(
        contrast(tokens.color.state.danger, background),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// ---------------------------------------------------------------------------
// Tailwind wiring
// ---------------------------------------------------------------------------

describe("tailwind extend", () => {
  const colors = extend.colors as Record<string, unknown>;
  const accent = accentPalette(DEFAULT_ACCENT);

  test("every surface token has a class", () => {
    expect(colors.bg0).toBe(tokens.color.bg["0"]);
    expect(colors.bg1).toBe(tokens.color.bg["1"]);
    expect(colors.bg2).toBe(tokens.color.bg["2"]);
    expect(colors.bg3).toBe(tokens.color.bg["3"]);
    expect(colors.surface).toEqual({
      0: tokens.color.bg["0"],
      1: tokens.color.bg["1"],
      2: tokens.color.bg["2"],
      3: tokens.color.bg["3"],
    });
  });

  test("every text tone has a class", () => {
    expect(colors.primary).toBe(tokens.color.text.primary);
    expect(colors.secondary).toBe(tokens.color.text.secondary);
    expect(colors.tertiary).toBe(tokens.color.text.tertiary);
    expect(colors.disabled).toBe(tokens.color.text.disabled);
    expect(colors["on-accent"]).toBe(accent.onAccent);
  });

  test("the accent classes carry the default accent, not a runtime one", () => {
    // NativeWind v2 compiles classes once, so a user-selected accent can only
    // arrive as an inline style. If this ever holds a non-default accent, the
    // build has baked one user's preference into everyone's bundle.
    expect(colors.accent).toEqual({
      400: accent[400],
      500: accent[500],
      600: accent[600],
      DEFAULT: accent[500],
    });
    expect(DEFAULT_ACCENT).toBe("teal");
  });

  test("every state and border token has a class", () => {
    expect(colors.success).toBe(tokens.color.state.success);
    expect(colors.warning).toBe(tokens.color.state.warning);
    expect(colors.danger).toBe(tokens.color.state.danger);
    expect(colors.info).toBe(tokens.color.state.info);
    expect(colors.subtle).toBe(tokens.color.border.subtle);
    expect(colors.strong).toBe(tokens.color.border.strong);
    expect(colors.focus).toBe(accent[400]);
  });

  test("every radius, spacing step and max width has a class", () => {
    for (const [name, value] of Object.entries(tokens.radius)) {
      expect(extend.borderRadius[name]).toBe(`${value}px`);
    }
    for (const [name, value] of Object.entries(tokens.space)) {
      expect(extend.spacing[name]).toBe(`${value}px`);
    }
    for (const [name, value] of Object.entries(tokens.gutter)) {
      expect(extend.spacing[`gutter-${name}`]).toBe(`${value}px`);
    }
    for (const [name, value] of Object.entries(tokens.maxWidth)) {
      expect(extend.maxWidth[name]).toBe(`${value}px`);
    }
  });

  test("every type variant has a class, at the compact size", () => {
    for (const name of Object.keys(tokens.type) as TypeVariant[]) {
      const { fontSize, lineHeight } = typeStyle(name, "compact");
      expect(extend.fontSize[name]).toEqual([
        `${fontSize}px`,
        { lineHeight: `${lineHeight}px` },
      ]);
    }
  });

  test("every font face has a family class", () => {
    expect(extend.fontFamily.sans).toEqual([tokens.fontFamily.regular]);
    expect(extend.fontFamily["sans-medium"]).toEqual([
      tokens.fontFamily.medium,
    ]);
    expect(extend.fontFamily["sans-semibold"]).toEqual([
      tokens.fontFamily.semibold,
    ]);
    expect(extend.fontFamily["sans-bold"]).toEqual([tokens.fontFamily.bold]);
  });

  test("the breakpoints match the ones useBreakpoint reports", () => {
    expect(extend.screens.medium).toBe(`${tokens.breakpoint.medium}px`);
    expect(extend.screens.expanded).toBe(`${tokens.breakpoint.expanded}px`);
  });

  test("both elevations have a shadow class", () => {
    expect(extend.boxShadow.e1).toBe("0px 4px 12px rgba(0,0,0,0.35)");
    expect(extend.boxShadow.e2).toBe("0px 8px 24px rgba(0,0,0,0.5)");
  });
});

// ---------------------------------------------------------------------------
// Type scale
// ---------------------------------------------------------------------------

describe("typeStyle", () => {
  const BREAKPOINTS: BreakpointName[] = ["compact", "medium", "expanded"];

  test("every variant is defined at every breakpoint", () => {
    for (const variant of Object.keys(tokens.type) as TypeVariant[]) {
      for (const breakpoint of BREAKPOINTS) {
        const style = typeStyle(variant, breakpoint);
        expect(Number.isFinite(style.fontSize)).toBe(true);
        expect(style.lineHeight).toBe(
          Math.round(style.fontSize * tokens.type[variant].lineHeight),
        );
      }
    }
  });

  test("the scale never shrinks as the window widens", () => {
    for (const variant of Object.keys(tokens.type) as TypeVariant[]) {
      const sizes = BREAKPOINTS.map((b) => typeStyle(variant, b).fontSize);
      expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    }
  });

  test("the scale is strictly ordered at every breakpoint", () => {
    // display > title > heading > body > caption > micro, always. A variant
    // that overtakes its neighbour is how a "heading" ends up smaller than the
    // paragraph under it at one width only.
    for (const breakpoint of BREAKPOINTS) {
      const sizes = (Object.keys(tokens.type) as TypeVariant[]).map(
        (v) => typeStyle(v, breakpoint).fontSize,
      );
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    }
  });

  test("the exact scale", () => {
    // Spelled out so a token edit is a deliberate, reviewable change rather
    // than a silent reflow of every screen.
    expect(
      Object.fromEntries(
        (Object.keys(tokens.type) as TypeVariant[]).map((v) => [
          v,
          BREAKPOINTS.map((b) => typeStyle(v, b).fontSize),
        ]),
      ),
    ).toEqual({
      display: [34, 41, 48],
      title: [26, 29, 32],
      heading: [20, 21, 22],
      body: [15, 16, 16],
      caption: [13, 13, 13],
      micro: [11, 12, 12],
    });
  });

  test("no body text falls below the 12 px floor the sweep enforces", () => {
    // `micro` is the one deliberate exception: badges and timestamps, never a
    // sentence. Everything a screen sets as running text has to clear 12.
    for (const variant of ["body", "caption"] as TypeVariant[]) {
      for (const breakpoint of BREAKPOINTS) {
        expect(typeStyle(variant, breakpoint).fontSize).toBeGreaterThanOrEqual(
          12,
        );
      }
    }
  });
});

describe("resolveTextStyle", () => {
  test("every variant x breakpoint resolves to a complete style", () => {
    for (const variant of Object.keys(tokens.type) as TypeVariant[]) {
      for (const breakpoint of [
        "compact",
        "medium",
        "expanded",
      ] as BreakpointName[]) {
        const style = resolveTextStyle(
          variant,
          "primary",
          "regular",
          breakpoint,
        );
        const size = typeStyle(variant, breakpoint);
        expect(style.fontSize).toBe(size.fontSize);
        expect(style.lineHeight).toBe(size.lineHeight);
        expect(style.color).toBe(tokens.color.text.primary);
        expect(style.fontFamily).toBe(tokens.fontFamily.regular);
        expect(String(style.fontWeight)).toBe(tokens.fontWeight.regular);
      }
    }
  });

  test("weight picks a face, not a synthesised one", () => {
    // Inter ships four static files. Asking a static face for weight 600 gets
    // a smeared fake on Android and is ignored on iOS, so the family carries
    // the weight and `fontWeight` is only there for the web fallback stack.
    expect(resolveTextStyle("body", "primary", "semibold").fontFamily).toBe(
      "Inter-SemiBold",
    );
    expect(resolveTextStyle("body", "primary", "bold").fontFamily).toBe(
      "Inter-Bold",
    );
  });

  test("tones resolve against the accent passed in", () => {
    for (const name of ACCENT_NAMES) {
      const palette = accentPalette(name);
      expect(
        resolveTextStyle("body", "accent", "regular", "compact", name).color,
      ).toBe(palette[500]);
      expect(
        resolveTextStyle("body", "onAccent", "regular", "compact", name).color,
      ).toBe(palette.onAccent);
    }
  });

  test("the defaults are body / primary / regular / compact", () => {
    expect(resolveTextStyle()).toEqual(
      resolveTextStyle("body", "primary", "regular", "compact", DEFAULT_ACCENT),
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  test("rgba expands both hex forms", () => {
    expect(rgba("#1FC7B5", 0.12)).toBe("rgba(31,199,181,0.12)");
    expect(rgba("#FFF", 1)).toBe("rgba(255,255,255,1)");
  });

  test("elevation carries an Android value as well as a shadow", () => {
    // Android reads only `elevation`; iOS and web read only the shadow props.
    // A style with one and not the other is invisible on half the platforms.
    for (const level of [1, 2] as const) {
      const style = elevation(level);
      expect(style.elevation).toBe(tokens.elevation[`${level}`].android);
      expect(style.shadowRadius).toBe(tokens.elevation[`${level}`].blur);
      expect(style.shadowOpacity).toBe(tokens.elevation[`${level}`].opacity);
    }
  });
});
