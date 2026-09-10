/** @type {import('tailwindcss').Config} */

// The design tokens live in one JSON so Tailwind and `constants/theme.ts` can
// never disagree. See that file's $comment for the rules.
//
// NativeWind v2 compiles these classes at build time and has no CSS variables,
// so the colors baked in here are the DEFAULT theme's. A person who picks
// Light or StingStream in Appearance gets their palette through
// `useTheme().color` as an inline style, never through a class.
//
// These color classes have no callers left and are on their way out; see the
// note on `colors` below. Everything else here — spacing, radii, type, screens
// — is theme-independent and stays.
//
// Token edits are invisible until Metro's cache is cleared: run
// `bunx expo start -c` (or `expo export` fresh) after touching this file.
const tokens = require("./constants/theme.tokens.json");

const defaultTheme = tokens.theme[tokens.defaultTheme];
const defaultAccent = defaultTheme.accent;

/** `{compact: 34, ...}` -> the compact value; Tailwind's scale is the phone one. */
const compactType = Object.fromEntries(
  Object.entries(tokens.type).map(([name, spec]) => [
    name,
    [
      `${spec.size.compact}px`,
      { lineHeight: `${Math.round(spec.size.compact * spec.lineHeight)}px` },
    ],
  ]),
);

const px = (scale) =>
  Object.fromEntries(
    Object.entries(scale).map(([name, value]) => [name, `${value}px`]),
  );

// The shadow's alpha is per-theme now, so a class can only carry the default
// theme's. Use `elevation(level, palette)` from `constants/theme.ts` instead.
const shadow = (level, opacity) =>
  `0px ${level.offsetY}px ${level.blur}px rgba(0,0,0,${opacity})`;

module.exports = {
  darkMode: "class",
  // `content` is not only Tailwind's scan list here: `nativewind/babel` skips
  // any file that does not match it, so a `className` in an unlisted directory
  // is never transformed and silently does nothing. Every directory that can
  // hold JSX is listed for that reason, not because Tailwind needs to scan it.
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
    "./hooks/**/*.{js,jsx,ts,tsx}",
    "./lib/**/*.{js,jsx,ts,tsx}",
    "./modules/**/*.{js,jsx,ts,tsx}",
    "./providers/**/*.{js,jsx,ts,tsx}",
    "./utils/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      screens: {
        medium: `${tokens.breakpoint.medium}px`,
        expanded: `${tokens.breakpoint.expanded}px`,
      },
      colors: {
        // Surfaces. `bg0..bg3` are the raw names from the token table;
        // `surface-0..3` is the same thing read as a role, so
        // `bg-surface-1` and `bg-bg1` are interchangeable.
        bg0: defaultTheme.bg["0"],
        bg1: defaultTheme.bg["1"],
        bg2: defaultTheme.bg["2"],
        bg3: defaultTheme.bg["3"],
        surface: {
          0: defaultTheme.bg["0"],
          1: defaultTheme.bg["1"],
          2: defaultTheme.bg["2"],
          3: defaultTheme.bg["3"],
        },

        // Text tones. Top-level on purpose: the plan's vocabulary is
        // `text-secondary`, not `text-text-secondary`.
        primary: defaultTheme.text.primary,
        secondary: defaultTheme.text.secondary,
        tertiary: defaultTheme.text.tertiary,
        disabled: defaultTheme.text.disabled,
        "on-accent": defaultAccent.onAccent,

        // The default theme's accent. Other themes are inline styles.
        accent: {
          400: defaultAccent["400"],
          500: defaultAccent["500"],
          600: defaultAccent["600"],
          DEFAULT: defaultAccent["500"],
        },

        success: defaultTheme.state.success,
        warning: defaultTheme.state.warning,
        danger: defaultTheme.state.danger,
        info: defaultTheme.state.info,

        // `border-subtle` / `border-strong`; `border-focus` is the accent ring.
        subtle: defaultTheme.border.subtle,
        strong: defaultTheme.border.strong,
        focus: defaultAccent.ring,
        scrim: defaultTheme.scrim,
      },
      borderRadius: px(tokens.radius),
      spacing: {
        ...px(tokens.space),
        "gutter-compact": `${tokens.gutter.compact}px`,
        "gutter-medium": `${tokens.gutter.medium}px`,
        "gutter-expanded": `${tokens.gutter.expanded}px`,
      },
      maxWidth: px(tokens.maxWidth),
      fontSize: compactType,
      fontFamily: {
        sans: [tokens.fontFamily.regular],
        "sans-medium": [tokens.fontFamily.medium],
        "sans-semibold": [tokens.fontFamily.semibold],
        "sans-bold": [tokens.fontFamily.bold],
      },
      boxShadow: {
        e1: shadow(tokens.elevation["1"], defaultTheme.elevationOpacity["1"]),
        e2: shadow(tokens.elevation["2"], defaultTheme.elevationOpacity["2"]),
      },
      transitionDuration: {
        fast: `${tokens.motion.fast}ms`,
        base: `${tokens.motion.base}ms`,
        slow: `${tokens.motion.slow}ms`,
      },
    },
  },
  plugins: [],
};
