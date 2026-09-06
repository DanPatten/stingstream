/** @type {import('tailwindcss').Config} */

// The design tokens live in one JSON so Tailwind and `constants/theme.ts` can
// never disagree. See that file's $comment for the rules.
//
// NativeWind v2 compiles these classes at build time and has no CSS variables,
// so the accent baked in here is the DEFAULT one (teal). A user who picks
// violet or amber in Appearance gets it through `useTheme().accent` as an
// inline style, never through a class. Anything that must follow the user's
// accent has to read the hook; `text-accent`/`bg-accent-500` are the brand
// colour, which is teal.
//
// Token edits are invisible until Metro's cache is cleared: run
// `bunx expo start -c` (or `expo export` fresh) after touching this file.
const tokens = require("./constants/theme.tokens.json");

const defaultAccent = tokens.color.accent[tokens.defaultAccent];

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

const shadow = (level) =>
  `0px ${level.offsetY}px ${level.blur}px rgba(0,0,0,${level.opacity})`;

module.exports = {
  darkMode: "class",
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
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
        bg0: tokens.color.bg["0"],
        bg1: tokens.color.bg["1"],
        bg2: tokens.color.bg["2"],
        bg3: tokens.color.bg["3"],
        surface: {
          0: tokens.color.bg["0"],
          1: tokens.color.bg["1"],
          2: tokens.color.bg["2"],
          3: tokens.color.bg["3"],
        },

        // Text tones. Top-level on purpose: the plan's vocabulary is
        // `text-secondary`, not `text-text-secondary`.
        primary: tokens.color.text.primary,
        secondary: tokens.color.text.secondary,
        tertiary: tokens.color.text.tertiary,
        disabled: tokens.color.text.disabled,
        "on-accent": defaultAccent.onAccent,

        // The brand accent (teal). Runtime-selected accents are inline styles.
        accent: {
          400: defaultAccent["400"],
          500: defaultAccent["500"],
          600: defaultAccent["600"],
          DEFAULT: defaultAccent["500"],
        },

        success: tokens.color.state.success,
        warning: tokens.color.state.warning,
        danger: tokens.color.state.danger,
        info: tokens.color.state.info,

        // `border-subtle` / `border-strong`; `border-focus` is the accent ring.
        subtle: tokens.color.border.subtle,
        strong: tokens.color.border.strong,
        focus: defaultAccent["400"],
        scrim: tokens.color.scrim.backdrop,
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
        e1: shadow(tokens.elevation["1"]),
        e2: shadow(tokens.elevation["2"]),
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
