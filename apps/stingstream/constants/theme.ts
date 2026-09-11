import type { TextStyle, ViewStyle } from "react-native";
import rawTokens from "./theme.tokens.json";

/**
 * The typed face of `theme.tokens.json`.
 *
 * Two consumers read that JSON: `tailwind.config.js`, which turns it into
 * utility classes, and this file, which turns it into values you can put in an
 * inline style. Everything else reads one of those two. A hex, a radius, a font
 * size or a shadow written anywhere else in the app is a bug — it is how the
 * fork ended up with nine colors in `Colors.ts` and inline hexes in a hundred
 * files.
 *
 * **NativeWind v2 has no CSS variables.** Classes are compiled once, at build
 * time, so a class can only ever carry one theme's answer. The theme a person
 * picks in Appearance is a runtime value and reaches the screen as an inline
 * style, through `useTheme().color` — see `hooks/useTheme.ts`.
 *
 * Token edits do not survive Metro's cache. Restart with `-c`.
 */

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export type ThemeName = keyof typeof rawTokens.theme;

/** Which way round a theme is, for the platform chrome that has only two options. */
export type ColorScheme = "dark" | "light";

/** Hover 400, rest 500, pressed 600, plus the roles that are not a shade of those. */
export interface AccentRamp {
  /** Hover. */
  400: string;
  /** Rest: primary buttons, progress, badges. */
  500: string;
  /** Pressed. */
  600: string;
  /**
   * The keyboard focus outline.
   *
   * Spelled out rather than derived from `400`, because it is not always a
   * shade of the accent: on `light` a pale blue ring on a white ground is
   * barely there, so the ring is the 500; on `sting` it is the mark's violet.
   */
  ring: string;
  /** Selected nav item, active tab, checked control. */
  active: string;
  /** Text and glyphs drawn *on* the 500 fill. */
  onAccent: string;
}

/**
 * Every color in the app, for one theme.
 *
 * A theme is not an accent: `light` moves the surfaces, the ink, the borders,
 * the state colors and the direction of the hover wash all at once, so all of
 * them live here rather than only the accent triad.
 *
 * Written out rather than inferred from the JSON, so this interface reads as the
 * contract a palette has to satisfy. `theme.test.ts` compares every theme's key
 * paths against the default one, which is what actually catches a half-filled
 * palette — a `light` missing `state.warning` would otherwise resolve to
 * `undefined` and paint an invisible badge on one theme only.
 */
export interface ThemePalette {
  scheme: ColorScheme;
  /** `0` app · `1` sidebar, cards, list groups · `2` inputs, sheets · `3` hover, pressed, chips. */
  bg: { 0: string; 1: string; 2: string; 3: string };
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    disabled: string;
  };
  accent: AccentRamp;
  state: { success: string; warning: string; danger: string; info: string };
  border: { subtle: string; strong: string };
  /**
   * The color of the hover and pressed washes, at `interaction`'s alphas.
   *
   * White on a dark theme, black on a light one. Hardcoding white is why a
   * light theme's rows would answer a pointer with nothing at all: white at 6 %
   * over a near-white card is a change no one can see.
   */
  overlay: string;
  /** Behind a dialog or a sheet. */
  scrim: string;
  /** Shadow alpha per elevation level; the geometry is shared. */
  elevationOpacity: { 1: number; 2: number };
}

const THEMES = rawTokens.theme as unknown as Record<ThemeName, ThemePalette>;

export const THEME_NAMES = Object.keys(THEMES) as readonly ThemeName[];

export const DEFAULT_THEME = rawTokens.defaultTheme as ThemeName;

/**
 * A theme's colors.
 *
 * Falls back to the default rather than returning `undefined`: a stale
 * persisted name must not take down the first render. `effectiveSettingsAtom`
 * already clamps the setting, so this is belt and braces.
 */
export const themePalette = (name: ThemeName = DEFAULT_THEME): ThemePalette =>
  THEMES[name] ?? THEMES[DEFAULT_THEME];

/** The palette anything outside React falls back to. Components read `useTheme().color`. */
export const DEFAULT_PALETTE = themePalette(DEFAULT_THEME);

/**
 * Every token that is *not* a colour: radius, space, type, motion, focus,
 * control, interaction, elevation geometry.
 *
 * There is no `tokens.color`. Colour is a runtime value now — three palettes,
 * one bundle, and NativeWind v2 has no CSS variables — so it reaches a
 * component through `useTheme().color` and a pure function through a
 * `ThemePalette` parameter. A `tokens.color` would only ever be one theme's
 * answer baked in, which is what this whole module exists to stop.
 */
export const tokens = rawTokens;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/**
 * `rgba("#3CDDFC", 0.12)` -> `"rgba(60,221,252,0.12)"`.
 *
 * React Native has no `color-mix()` and no eight-digit hex on every platform,
 * so tinted fills (a chip behind an accent glyph, a pressed row) go through
 * here rather than through a second hardcoded hex.
 */
export const rgba = (hex: string, alpha: number): string => {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const int = Number.parseInt(full.slice(0, 6), 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},${alpha})`;
};

/**
 * The same color at a different alpha, `"transparent"` left alone.
 *
 * A disabled filled button fades its fill rather than the whole control, so
 * `fade(color.accent[500], 0.35)` is the fill and `fade(onAccent, 0.6)` the
 * label — see `interaction` in the token JSON for why the two alphas differ.
 */
export const fade = (color: string, alpha: number): string =>
  color === "transparent" || !color.startsWith("#")
    ? color
    : rgba(color, alpha);

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

export type ElevationLevel = 1 | 2;

/**
 * e1 is a card lifting on hover, e2 is a sheet or dialog over the page.
 *
 * Returns iOS/web shadow props *and* Android's `elevation` in one style, the
 * way every RN shadow has to be written; `shadowColor` is black at the theme's
 * opacity rather than a translucent color, because Android reads only
 * `elevation` and would otherwise drop the alpha entirely.
 *
 * The opacity comes from the palette: the same 0.35 that reads as depth on
 * near-black reads as soot under a card on white.
 */
export const elevation = (
  level: ElevationLevel,
  palette: ThemePalette = DEFAULT_PALETTE,
): ViewStyle => {
  const spec = rawTokens.elevation[String(level) as "1" | "2"];
  return {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: spec.offsetY },
    shadowOpacity: palette.elevationOpacity[level],
    shadowRadius: spec.blur,
    elevation: spec.android,
  };
};

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export type TypeVariant = keyof typeof rawTokens.type;
export type BreakpointName = keyof typeof rawTokens.breakpoint;
export type TextWeight = keyof typeof rawTokens.fontFamily;
export type TextTone =
  | "primary"
  | "secondary"
  | "tertiary"
  | "disabled"
  | "accent"
  | "danger"
  | "onAccent";

/**
 * Font size and line height for one variant at one width.
 *
 * The plan's type table gives each variant a phone number and a web number
 * (`display 34/48`); `compact` is the phone anchor, `expanded` the web one, and
 * `medium` sits between them. The three sizes are spelled out in the token JSON
 * rather than derived from a multiplier so that "what size is a heading at
 * 1024?" has one answer you can read, and so the test can pin all eighteen.
 */
export const typeStyle = (
  variant: TypeVariant,
  breakpoint: BreakpointName = "compact",
): Required<Pick<TextStyle, "fontSize" | "lineHeight">> => {
  const spec = rawTokens.type[variant];
  const fontSize = spec.size[breakpoint];
  return { fontSize, lineHeight: Math.round(fontSize * spec.lineHeight) };
};

const TONE_COLORS: Record<TextTone, (palette: ThemePalette) => string> = {
  primary: (p) => p.text.primary,
  secondary: (p) => p.text.secondary,
  tertiary: (p) => p.text.tertiary,
  disabled: (p) => p.text.disabled,
  accent: (p) => p.accent[500],
  danger: (p) => p.state.danger,
  onAccent: (p) => p.accent.onAccent,
};

/** The color a tone resolves to under a given theme. */
export const toneColor = (
  tone: TextTone,
  palette: ThemePalette = DEFAULT_PALETTE,
): string => TONE_COLORS[tone](palette);

/**
 * The whole text style for a variant/tone/weight/breakpoint, in one call.
 *
 * `components/common/Text.tsx` is the only thing that should need it, but it is
 * exported because a few places (a `TextInput`, an animated label) style text
 * without rendering a `Text`.
 *
 * The weight is carried by the *font family*, not `fontWeight`: Inter ships as
 * four static faces, and asking a static face for weight 600 gets a synthesised
 * smear on Android and nothing at all on iOS. `fontWeight` is set as well so
 * react-native-web picks the right face when the font fails to load and the
 * system stack takes over.
 */
export const resolveTextStyle = (
  variant: TypeVariant = "body",
  tone: TextTone = "primary",
  weight: TextWeight = "regular",
  breakpoint: BreakpointName = "compact",
  palette: ThemePalette = DEFAULT_PALETTE,
): TextStyle => ({
  ...typeStyle(variant, breakpoint),
  color: toneColor(tone, palette),
  fontFamily: rawTokens.fontFamily[weight],
  fontWeight: rawTokens.fontWeight[weight] as TextStyle["fontWeight"],
});

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

/**
 * The keyboard focus ring for web. **Call it only on web.**
 *
 * react-native-web maps `outlineWidth`/`outlineColor`/`outlineOffset` onto the
 * real CSS outline, which is the only focus indicator that does not shift
 * layout — but those three are not valid React Native style properties, so a
 * native renderer would warn about every one of them. The `Platform` check
 * lives at the call site rather than here so this module stays free of any
 * runtime react-native import: it is read by `tailwind.config.js`'s test and by
 * plain `bun test` specs, neither of which can load React Native.
 *
 * **The ring is drawn *inside* the control** — a negative `outline-offset` — and
 * that is the whole point of this function. It used to sit 2px outside, which
 * is the prettier place for it and the wrong one: a CSS outline is painted
 * outside the border box, so every ancestor that clips cuts it off. A
 * horizontal `ScrollView` is `overflow-x: auto; overflow-y: hidden` on web, so
 * every chip bar and tab strip sheared the ring flat along the top; a rounded
 * card with `overflow: hidden` around a full-bleed row swallowed it whole, so
 * the focused row showed nothing at all. Measured across the app at two
 * viewports, 445 controls were clipped — Dan: *"happens all over the site"*.
 *
 * Padding the containers was the previous answer and it does not hold: it is
 * four pixels that every new scroller, sheet and card has to remember, and the
 * one it forgets looks like a rendering fault rather than a missing rule. An
 * inset ring cannot be clipped by anything, needs no cooperation from any
 * container, and still shifts no layout.
 *
 * The one thing it costs is contrast, because the ring now lands on the
 * control's own surface: an accent ring inside an accent-filled chip is
 * invisible. Pass `ringColor` where the surface is not a neutral one — the
 * control's own label colour is always the right answer, since it is already
 * chosen to be legible on that fill.
 *
 * TV focus is the white ring and scale in `docs/conventions/tv.md`, never the
 * accent.
 */
export const webFocusRing = (
  focused: boolean,
  palette: ThemePalette = DEFAULT_PALETTE,
  ringColor?: string,
): ViewStyle => {
  const style = {
    outlineStyle: focused ? "solid" : "none",
    outlineWidth: focused ? rawTokens.focus.web.width : 0,
    outlineColor: ringColor ?? palette.accent.ring,
    outlineOffset: -rawTokens.focus.web.inset,
  };
  return style as unknown as ViewStyle;
};

// ---------------------------------------------------------------------------
// Flat aliases, for the places that only want one value
// ---------------------------------------------------------------------------

export const radius = rawTokens.radius;
export const space = rawTokens.space;
export const gutter = rawTokens.gutter;
export const breakpoints = rawTokens.breakpoint;
export const maxWidth = rawTokens.maxWidth;
export const motion = rawTokens.motion;
export const fontFamily = rawTokens.fontFamily;
export const control = rawTokens.control;
export const interaction = rawTokens.interaction;
