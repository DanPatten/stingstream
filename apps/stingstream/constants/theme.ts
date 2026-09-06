import type { TextStyle, ViewStyle } from "react-native";
import rawTokens from "./theme.tokens.json";

/**
 * The typed face of `theme.tokens.json`.
 *
 * Two consumers read that JSON: `tailwind.config.js`, which turns it into
 * utility classes, and this file, which turns it into values you can put in an
 * inline style. Everything else reads one of those two. A hex, a radius, a font
 * size or a shadow written anywhere else in the app is a bug — it is how the
 * fork ended up with nine colours in `Colors.ts` and inline hexes in a hundred
 * files.
 *
 * **NativeWind v2 has no CSS variables.** Classes are compiled once, at build
 * time, so `bg-accent-500` is always the *default* accent (teal, the brand
 * colour). The accent a user picks in Appearance is a runtime value and reaches
 * the screen as an inline style, through `useTheme().accent` — see
 * `hooks/useTheme.ts`. Both are correct in their place: brand furniture stays
 * teal, user-accented furniture reads the hook.
 *
 * Token edits do not survive Metro's cache. Restart with `-c`.
 */
export const tokens = rawTokens;

// ---------------------------------------------------------------------------
// Accents
// ---------------------------------------------------------------------------

export type AccentName = keyof typeof rawTokens.color.accent;

export interface AccentPalette {
  /** Hover / focus ring. */
  400: string;
  /** Rest state: primary buttons, progress, badges, active nav. */
  500: string;
  /** Pressed. */
  600: string;
  /** Text and glyphs drawn *on* the 500 fill. */
  onAccent: string;
}

export const ACCENT_NAMES = Object.keys(
  rawTokens.color.accent,
) as readonly AccentName[];

export const DEFAULT_ACCENT = rawTokens.defaultAccent as AccentName;

/**
 * The three shades plus the text colour that reads on them.
 *
 * `onAccent` is per-accent rather than one global token because no single
 * foreground works on all three: the dark `#04201D` reaches 8:1 on teal and
 * amber, but only 3.2:1 on violet, whose maximum against *any* foreground is
 * white at 5.4:1. See `theme.test.ts`.
 */
export const accentPalette = (
  name: AccentName = DEFAULT_ACCENT,
): AccentPalette => rawTokens.color.accent[name];

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

/**
 * `rgba("#1FC7B5", 0.12)` -> `"rgba(31,199,181,0.12)"`.
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

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

export type ElevationLevel = 1 | 2;

/**
 * e1 is a card lifting on hover, e2 is a sheet or dialog over the page.
 *
 * Returns iOS/web shadow props *and* Android's `elevation` in one style, the
 * way every RN shadow has to be written; `shadowColor` is black at the token's
 * opacity rather than a translucent colour, because Android reads only
 * `elevation` and would otherwise drop the alpha entirely.
 */
export const elevation = (level: ElevationLevel): ViewStyle => {
  const spec = rawTokens.elevation[String(level) as "1" | "2"];
  return {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: spec.offsetY },
    shadowOpacity: spec.opacity,
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

const TONE_COLORS: Record<TextTone, (accent: AccentPalette) => string> = {
  primary: () => rawTokens.color.text.primary,
  secondary: () => rawTokens.color.text.secondary,
  tertiary: () => rawTokens.color.text.tertiary,
  disabled: () => rawTokens.color.text.disabled,
  accent: (accent) => accent[500],
  danger: () => rawTokens.color.state.danger,
  onAccent: (accent) => accent.onAccent,
};

/** The colour a tone resolves to under a given accent. */
export const toneColor = (
  tone: TextTone,
  accent: AccentName = DEFAULT_ACCENT,
): string => TONE_COLORS[tone](accentPalette(accent));

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
  accent: AccentName = DEFAULT_ACCENT,
): TextStyle => ({
  ...typeStyle(variant, breakpoint),
  color: toneColor(tone, accent),
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
 * TV focus is the white ring and scale in `docs/conventions/tv.md`, never the
 * accent.
 */
export const webFocusRing = (
  focused: boolean,
  accent: AccentName = DEFAULT_ACCENT,
): ViewStyle => {
  const style = {
    outlineStyle: focused ? "solid" : "none",
    outlineWidth: focused ? rawTokens.focus.web.width : 0,
    outlineColor: accentPalette(accent)[400],
    outlineOffset: rawTokens.focus.web.offset,
  };
  return style as unknown as ViewStyle;
};

// ---------------------------------------------------------------------------
// Flat aliases, for the places that only want one value
// ---------------------------------------------------------------------------

export const surface = rawTokens.color.bg;
export const textColor = rawTokens.color.text;
export const stateColor = rawTokens.color.state;
export const borderColor = rawTokens.color.border;
export const radius = rawTokens.radius;
export const space = rawTokens.space;
export const gutter = rawTokens.gutter;
export const breakpoints = rawTokens.breakpoint;
export const maxWidth = rawTokens.maxWidth;
export const motion = rawTokens.motion;
export const fontFamily = rawTokens.fontFamily;
export const control = rawTokens.control;
