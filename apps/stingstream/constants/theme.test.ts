import { describe, expect, test } from "bun:test";
import {
  type BreakpointName,
  DEFAULT_PALETTE,
  DEFAULT_THEME,
  elevation,
  fade,
  interaction,
  resolveTextStyle,
  rgba,
  THEME_NAMES,
  type ThemePalette,
  type TypeVariant,
  themePalette,
  tokens,
  typeStyle,
  webFocusRing,
} from "./theme";

// The design system's three promises, pinned:
//
//  1. Text is readable — on every theme, not just the one whoever made the
//     change happened to be looking at. Dark-only UIs drift towards grey-on-grey
//     one commit at a time; a light theme added on top of one drifts twice as
//     fast, because half the palette is never on screen while it is being
//     edited. The ratios below are the plan's own targets, computed the way
//     WCAG computes them.
//  2. The three palettes are the same shape. A `light` missing `state.warning`
//     resolves to `undefined` and paints an invisible badge on one theme only.
//  3. Tailwind and `theme.ts` cannot disagree, because both read the same JSON
//     — and the third block proves the JSON actually reached the Tailwind
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

/** Every theme, with its name, so a failure says which one broke. */
const eachTheme = (): [string, ThemePalette][] =>
  THEME_NAMES.map((name) => [name, themePalette(name)]);

const SURFACE_STEPS = ["0", "1", "2", "3"] as const;

describe("contrast", () => {
  test("the ratio helper agrees with the known endpoints", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  test("secondary text on a card reaches AA in every theme", () => {
    // Card, list-group and sidebar backgrounds are bg1; secondary is the
    // subtitle under every row title.
    for (const [name, p] of eachTheme()) {
      expect({
        theme: name,
        ok: contrast(p.text.secondary, p.bg[1]) >= 4.5,
      }).toEqual({ theme: name, ok: true });
    }
  });

  test("primary text reaches AAA on every surface of every theme", () => {
    for (const [name, p] of eachTheme()) {
      for (const step of SURFACE_STEPS) {
        const at = `${name}.bg${step}`;
        expect({
          at,
          ok: contrast(p.text.primary, p.bg[Number(step) as 0]) >= 7,
        }).toEqual({ at, ok: true });
      }
    }
  });

  test("on-accent text reaches AAA on every theme's accent", () => {
    // The old "violet is held to AA" exemption is gone with the accent it
    // described: `#9334E9` was the fork's legacy purple and no foreground
    // reached 7:1 on it. `sting` still uses violet, but only for `ring` and
    // `active`, which carry no text and are held to the 3:1 rule below.
    for (const [name, p] of eachTheme()) {
      expect({
        theme: name,
        ok: contrast(p.accent.onAccent, p.accent[500]) >= 7,
      }).toEqual({ theme: name, ok: true });
    }
  });

  test("the ring and the active tint are visible against the surface behind them", () => {
    // WCAG 1.4.11: a non-text indicator needs 3:1. This is what catches
    // `sting`'s violet ring on its indigo bg1 — the one pairing in the set
    // where the two are close enough in luminance to disappear.
    for (const [name, p] of eachTheme()) {
      for (const role of ["ring", "active"] as const) {
        const at = `${name}.accent.${role}`;
        expect({ at, ok: contrast(p.accent[role], p.bg[1]) >= 3 }).toEqual({
          at,
          ok: true,
        });
      }
    }
  });

  test("every state color is readable on every surface of every theme", () => {
    // Not just danger. A warning badge that is legible on near-black and
    // invisible on white is the same bug, found six months later.
    for (const [name, p] of eachTheme()) {
      for (const [role, hex] of Object.entries(p.state)) {
        for (const step of SURFACE_STEPS) {
          const at = `${name}.${role} on bg${step}`;
          expect({
            at,
            ok: contrast(hex, p.bg[Number(step) as 0]) >= 4.5,
          }).toEqual({ at, ok: true });
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Palette shape
// ---------------------------------------------------------------------------

describe("palette shape", () => {
  /** Every leaf key path in an object, `"accent.onAccent"` style. */
  const paths = (value: object, prefix = ""): string[] =>
    Object.entries(value).flatMap(([key, child]) =>
      child && typeof child === "object"
        ? paths(child, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    );

  test("every theme has exactly the keys the default has", () => {
    // The `$comment` arrays differ by theme and are documentation, not tokens.
    const keys = (p: ThemePalette) =>
      paths(p)
        .filter((k) => !k.startsWith("$comment"))
        .sort();
    const reference = keys(DEFAULT_PALETTE);
    for (const [name, p] of eachTheme()) {
      expect({ theme: name, keys: keys(p) }).toEqual({
        theme: name,
        keys: reference,
      });
    }
  });

  test("a theme's scheme matches the luminance of its surfaces", () => {
    // The one field nothing else can derive, so nothing else can catch it
    // wrong — and it drives `Appearance.setColorScheme`, the system bars and
    // which of React Navigation's two base themes the chrome is built from.
    for (const [name, p] of eachTheme()) {
      const scheme =
        luminance(p.bg[0]) < luminance(p.text.primary) ? "dark" : "light";
      expect({ theme: name, scheme }).toEqual({
        theme: name,
        scheme: p.scheme,
      });
    }
  });

  test("the surface ramp moves away from the page one step at a time", () => {
    // bg0 is furthest from the text, bg3 closest, and `usePressableStates`
    // describes hover as "one step up the surface scale". A ramp that reverses
    // at one step makes an elevated sheet read as a hole.
    for (const [name, p] of eachTheme()) {
      const ramp = SURFACE_STEPS.map((s) => luminance(p.bg[Number(s) as 0]));
      const ordered =
        p.scheme === "dark"
          ? [...ramp].sort((a, b) => a - b)
          : [...ramp].sort((a, b) => b - a);
      expect({ theme: name, ramp }).toEqual({ theme: name, ramp: ordered });
    }
  });

  test("the hover wash actually washes", () => {
    // The light-theme trap: `overlayFor` used to lay white over everything, and
    // white at 6 % on a near-white card is a change nobody can see. A theme
    // whose overlay does not contrast with its own cards has no hover states.
    for (const [name, p] of eachTheme()) {
      expect({ theme: name, ok: contrast(p.overlay, p.bg[1]) >= 1.5 }).toEqual({
        theme: name,
        ok: true,
      });
    }
  });

  test("a light theme's shadows are lighter than a dark theme's", () => {
    // Black at 0.35 under a card reads as depth on near-black and as soot on
    // white, which is why the opacity is per-theme rather than shared.
    for (const [name, p] of eachTheme()) {
      if (p.scheme !== "light") continue;
      expect({ theme: name, ok: p.elevationOpacity[1] < 0.2 }).toEqual({
        theme: name,
        ok: true,
      });
    }
    for (const [, p] of eachTheme()) {
      expect(p.elevationOpacity[2]).toBeGreaterThan(p.elevationOpacity[1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Tailwind wiring
// ---------------------------------------------------------------------------

describe("tailwind extend", () => {
  const colors = extend.colors as Record<string, unknown>;
  const accent = DEFAULT_PALETTE.accent;

  test("every surface token has a class", () => {
    expect(colors.bg0).toBe(DEFAULT_PALETTE.bg[0]);
    expect(colors.bg1).toBe(DEFAULT_PALETTE.bg[1]);
    expect(colors.bg2).toBe(DEFAULT_PALETTE.bg[2]);
    expect(colors.bg3).toBe(DEFAULT_PALETTE.bg[3]);
    expect(colors.surface).toEqual({
      0: DEFAULT_PALETTE.bg[0],
      1: DEFAULT_PALETTE.bg[1],
      2: DEFAULT_PALETTE.bg[2],
      3: DEFAULT_PALETTE.bg[3],
    });
  });

  test("every text tone has a class", () => {
    expect(colors.primary).toBe(DEFAULT_PALETTE.text.primary);
    expect(colors.secondary).toBe(DEFAULT_PALETTE.text.secondary);
    expect(colors.tertiary).toBe(DEFAULT_PALETTE.text.tertiary);
    expect(colors.disabled).toBe(DEFAULT_PALETTE.text.disabled);
    expect(colors["on-accent"]).toBe(accent.onAccent);
  });

  test("the color classes carry the default theme, not a runtime one", () => {
    // NativeWind v2 compiles classes once, so a chosen theme can only ever
    // arrive as an inline style. If this holds a non-default theme, the build
    // has baked one person's preference into everyone's bundle.
    expect(colors.accent).toEqual({
      400: accent[400],
      500: accent[500],
      600: accent[600],
      DEFAULT: accent[500],
    });
    expect(colors.focus).toBe(accent.ring);
    expect(DEFAULT_THEME).toBe("dark");
  });

  test("every state and border token has a class", () => {
    expect(colors.success).toBe(DEFAULT_PALETTE.state.success);
    expect(colors.warning).toBe(DEFAULT_PALETTE.state.warning);
    expect(colors.danger).toBe(DEFAULT_PALETTE.state.danger);
    expect(colors.info).toBe(DEFAULT_PALETTE.state.info);
    expect(colors.subtle).toBe(DEFAULT_PALETTE.border.subtle);
    expect(colors.strong).toBe(DEFAULT_PALETTE.border.strong);
    expect(colors.scrim).toBe(DEFAULT_PALETTE.scrim);
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

  test("both elevations have a shadow class, at the default theme's opacity", () => {
    expect(extend.boxShadow.e1).toBe(
      `0px 4px 12px rgba(0,0,0,${DEFAULT_PALETTE.elevationOpacity[1]})`,
    );
    expect(extend.boxShadow.e2).toBe(
      `0px 8px 24px rgba(0,0,0,${DEFAULT_PALETTE.elevationOpacity[2]})`,
    );
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
      micro: [12, 12, 12],
    });
  });

  test("nothing on the scale falls below the 12 px floor", () => {
    // 12 px is the accessibility floor the screenshot sweep enforces: anything
    // under it is a finding, and `micro` used to be the one exception at 11.
    // It is not any more — the 11 was chosen only because pass-01 asked the tab
    // bar for "10-11 px", and five labels fit a 360 dp bar at 12 anyway. There
    // is now no size in the system a screen can legitimately reach for that is
    // too small to read.
    for (const variant of Object.keys(tokens.type) as TypeVariant[]) {
      for (const breakpoint of BREAKPOINTS) {
        expect({
          variant,
          breakpoint,
          ok: typeStyle(variant, breakpoint).fontSize >= 12,
        }).toEqual({ variant, breakpoint, ok: true });
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
        expect(style.color).toBe(DEFAULT_PALETTE.text.primary);
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

  test("every tone resolves against the theme passed in", () => {
    // The lever the whole change turns on: `Text` and `Icon` both color
    // themselves through `toneColor`, so if a tone ignored the palette, most of
    // the app's foreground would stay dark on the light theme.
    for (const [name, p] of eachTheme()) {
      const expected = {
        primary: p.text.primary,
        secondary: p.text.secondary,
        tertiary: p.text.tertiary,
        disabled: p.text.disabled,
        accent: p.accent[500],
        danger: p.state.danger,
        onAccent: p.accent.onAccent,
      };
      for (const [tone, hex] of Object.entries(expected)) {
        const at = `${name}.${tone}`;
        expect({
          at,
          color: resolveTextStyle(
            "body",
            tone as keyof typeof expected,
            "regular",
            "compact",
            p,
          ).color,
        }).toEqual({ at, color: hex });
      }
    }
  });

  test("the defaults are body / primary / regular / compact / the default theme", () => {
    expect(resolveTextStyle()).toEqual(
      resolveTextStyle(
        "body",
        "primary",
        "regular",
        "compact",
        DEFAULT_PALETTE,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("interaction", () => {
  test("the overlays are alphas, not colors", () => {
    for (const alpha of [
      interaction.hoverOverlay,
      interaction.pressedOverlay,
      interaction.disabledFillAlpha,
      interaction.disabledLabelAlpha,
      interaction.skeletonMinOpacity,
    ]) {
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThanOrEqual(1);
    }
  });

  test("pressed is stronger than hover", () => {
    // Otherwise pressing a control that is already hovered makes it *less*
    // lit, which reads as the press not registering.
    expect(interaction.pressedOverlay).toBeGreaterThan(
      interaction.hoverOverlay,
    );
  });

  test("a disabled label stays more solid than its fill", () => {
    // The rule the whole two-alpha scheme exists for: fade them equally and
    // the label floats on an invisible fill, which reads as a link rather
    // than as a switched-off button. See docs/UI-DESIGN.md.
    expect(interaction.disabledLabelAlpha).toBeGreaterThan(
      interaction.disabledFillAlpha,
    );
  });

  test("a disabled primary button is still visible", () => {
    // 35 % of the accent on bg0 has to stay distinguishable from the page, or
    // the button disappears instead of switching off.
    const faded = fade(
      DEFAULT_PALETTE.accent[500],
      interaction.disabledFillAlpha,
    );
    expect(faded).toBe("rgba(60,221,252,0.35)");
  });
});

describe("helpers", () => {
  test("rgba expands both hex forms", () => {
    expect(rgba("#3CDDFC", 0.12)).toBe("rgba(60,221,252,0.12)");
    expect(rgba("#FFF", 1)).toBe("rgba(255,255,255,1)");
  });

  test("fade thins a color and leaves the non-colors alone", () => {
    expect(fade("#3CDDFC", 0.35)).toBe("rgba(60,221,252,0.35)");
    // A ghost button's rest fill is the literal string, not a color, and a
    // caller should not have to special-case it before asking for 35 % of it.
    expect(fade("transparent", 0.35)).toBe("transparent");
    expect(fade("rgba(255,255,255,0.08)", 0.5)).toBe("rgba(255,255,255,0.08)");
  });

  test("elevation carries an Android value as well as a shadow", () => {
    // Android reads only `elevation`; iOS and web read only the shadow props.
    // A style with one and not the other is invisible on half the platforms.
    for (const level of [1, 2] as const) {
      const style = elevation(level);
      expect(style.elevation).toBe(tokens.elevation[`${level}`].android);
      expect(style.shadowRadius).toBe(tokens.elevation[`${level}`].blur);
      expect(style.shadowOpacity).toBe(DEFAULT_PALETTE.elevationOpacity[level]);
    }
  });

  test("the focus ring is drawn inside the control, never outside it", () => {
    // The whole reason this helper exists. A CSS outline is painted outside the
    // border box, so a positive offset puts the ring where any ancestor with
    // `overflow` other than `visible` can cut it off -- a horizontal ScrollView
    // (`overflow-y: hidden` on web) shears it flat along the top of every chip
    // bar and tab strip, and a rounded card with `overflow: hidden` swallows it
    // whole. Measured across the app at two viewports before this was fixed:
    // 445 clipped controls. A negative offset cannot be clipped by anything.
    const ring = webFocusRing(true) as Record<string, unknown>;
    expect(ring.outlineOffset).toBe(-tokens.focus.web.inset);
    expect(tokens.focus.web.inset).toBeGreaterThan(0);
    expect(ring.outlineWidth).toBe(tokens.focus.web.width);
    expect(ring.outlineStyle).toBe("solid");
  });

  test("the ring is the accent by default and the caller's colour on a fill", () => {
    // Drawn inside the control, an accent ring on an accent-filled chip is
    // invisible -- so a filled control passes the colour its own label uses.
    for (const [name, p] of eachTheme()) {
      const at = `${name}.ring`;
      expect({
        at,
        color: (webFocusRing(true, p) as Record<string, unknown>).outlineColor,
      }).toEqual({ at, color: p.accent.ring });
      const onFill = webFocusRing(true, p, p.accent.onAccent) as Record<
        string,
        unknown
      >;
      expect({ at, color: onFill.outlineColor }).toEqual({
        at,
        color: p.accent.onAccent,
      });
    }
  });

  test("an unfocused control draws no ring at all", () => {
    const ring = webFocusRing(false) as Record<string, unknown>;
    expect(ring.outlineStyle).toBe("none");
    expect(ring.outlineWidth).toBe(0);
  });

  test("elevation takes its opacity from the theme it is drawn on", () => {
    for (const [name, p] of eachTheme()) {
      const at = `${name}.e2`;
      expect({ at, opacity: elevation(2, p).shadowOpacity }).toEqual({
        at,
        opacity: p.elevationOpacity[2],
      });
    }
  });
});
