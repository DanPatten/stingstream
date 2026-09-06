import { useAtomValue } from "jotai";
import {
  Platform,
  Text as RNText,
  type TextProps,
  type TextStyle,
} from "react-native";
import type { ScaledTVTypography } from "@/constants/TVTypography";
import {
  type BreakpointName,
  DEFAULT_ACCENT,
  resolveTextStyle,
  type TextTone,
  type TextWeight,
  type TypeVariant,
  toneColor,
  typeStyle,
} from "@/constants/theme";
import { useBreakpointName } from "@/hooks/useBreakpoint";

// ---------------------------------------------------------------------------
// Two lazy requires, and why they cannot be plain imports
// ---------------------------------------------------------------------------
//
// `utils/atoms/settings.ts` imports `BITRATES` from
// `components/BitrateSelector.tsx`, which imports *this* file. So any
// module-scope import from here back into settings closes a require cycle —
// and one of the modules on that ring, `constants/TVTypography.ts`, reads the
// `TVTypographyScale` enum out of settings in its own module body. Reached
// mid-initialisation it gets a half-built module object and the whole app dies
// on load with "Cannot access 'TVTypographyScale' before initialization"
// (observed, not theorised: it broke the web bundle the first time these were
// ordinary imports).
//
// Requiring them on first render instead moves the read past every module's
// evaluation, when both are complete. The result is cached, so this costs one
// property lookup per render — which matters, because `Text` is the most
// frequently rendered component in the app.
//
// The real fix is for `BITRATES` to live in `constants/` rather than in a
// component; that belongs to whoever owns `BitrateSelector.tsx`.

type SettingsModule = typeof import("@/utils/atoms/settings");
type TVTypographyModule = typeof import("@/constants/TVTypography");

let settingsModule: SettingsModule | null = null;
const settings = (): SettingsModule => {
  settingsModule ??= require("@/utils/atoms/settings") as SettingsModule;
  return settingsModule;
};

let tvTypographyModule: TVTypographyModule | null = null;
const tvTypography = (): TVTypographyModule => {
  tvTypographyModule ??=
    require("@/constants/TVTypography") as TVTypographyModule;
  return tvTypographyModule;
};

export interface StingTextProps extends TextProps {
  /** The step on the type scale. Defaults to `body`. */
  variant?: TypeVariant;
  /** What the text *is*, not what colour it is. Defaults to `primary`. */
  tone?: TextTone;
  /**
   * Which Inter face to use. The weight rides on the family, not on
   * `fontWeight`: four static faces cannot be interpolated, and asking one for
   * weight 600 gets a synthesised smear on Android and nothing on iOS.
   */
  weight?: TextWeight;
  align?: TextStyle["textAlign"];
  /**
   * Size for a width other than the window's — a card narrower than the page it
   * sits on, a preview rendered at a fixed size. Rarely needed.
   */
  breakpoint?: BreakpointName;
}

/**
 * The accent, read straight off the settings atom.
 *
 * Not `useSettings()`: that hook subscribes to three atoms, builds two
 * callbacks and runs an effect on every call, and `Text` renders hundreds of
 * times on a busy screen. One atom read is all this needs.
 */
const useAccent = () =>
  useAtomValue(settings().effectiveSettingsAtom).accent ?? DEFAULT_ACCENT;

function PhoneText({
  variant,
  tone = "primary",
  weight = "regular",
  align,
  breakpoint,
  style,
  ...otherProps
}: StingTextProps) {
  const accent = useAccent();
  const windowBreakpoint = useBreakpointName();
  const resolved = resolveTextStyle(
    variant ?? "body",
    tone,
    weight,
    breakpoint ?? windowBreakpoint,
    accent,
  );

  return (
    <RNText
      allowFontScaling={false}
      style={[
        {
          ...resolved,
          // Only text that asked for a variant gets the scale's line height.
          // The fork has around a thousand `<Text className="text-xs">` call
          // sites whose size comes from a class; pinning a 22 px line height
          // under a 12 px class would loosen every one of those rows before its
          // own package has restyled it. A variant is the opt-in.
          lineHeight: variant ? resolved.lineHeight : undefined,
          textAlign: align,
        },
        style,
      ]}
      {...otherProps}
    />
  );
}

/**
 * The six phone/web variants onto the five TV ones.
 *
 * `caption` and `micro` both land on `callout`: TV has no size below it that is
 * legible across a room, and small print is a phone idea. `TVTypography`
 * already applies the user's typography-scale setting, so nothing here
 * multiplies anything — hardcoding a TV font size is what
 * `docs/conventions/tv.md` forbids.
 */
const TV_VARIANTS: Record<TypeVariant, keyof ScaledTVTypography> = {
  display: "display",
  title: "title",
  heading: "heading",
  body: "body",
  caption: "callout",
  micro: "callout",
};

/** TV keeps the system font, so weight is the only lever it has. */
const TV_WEIGHTS: Record<TextWeight, TextStyle["fontWeight"]> = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
};

function TVText({
  variant,
  tone = "primary",
  weight = "regular",
  align,
  breakpoint: _breakpoint,
  style,
  ...otherProps
}: StingTextProps) {
  const accent = useAccent();
  const typography = tvTypography().useScaledTVTypography();

  return (
    <RNText
      allowFontScaling={false}
      style={[
        {
          // Same opt-in as the phone branch: an untouched TV call site keeps
          // whatever size it already sets for itself.
          fontSize: variant ? typography[TV_VARIANTS[variant]] : undefined,
          color: toneColor(tone, accent),
          fontWeight: TV_WEIGHTS[weight],
          textAlign: align,
        },
        style,
      ]}
      {...otherProps}
    />
  );
}

/**
 * Every piece of text in the app.
 *
 * One API across phone, web and television: a `variant` picks a step on the
 * type scale, a `tone` says what the text *is* rather than what colour it is,
 * and a `weight` picks an Inter face. On TV the same variant resolves against
 * `useScaledTVTypography()` instead, because TV text is sized from the panel
 * and the user's typography setting, and TV keeps the system font.
 *
 * `className` and `style` still pass through and still win — NativeWind appends
 * the caller's styles after the ones resolved here — so every existing call
 * site renders as it did until its own package restyles it.
 *
 * The platform branch is picked once, at module scope: `Platform.isTV` cannot
 * change while the process lives, and choosing inside the component would mean
 * every phone render also paying for the TV typography hook.
 */
export const Text = Platform.isTV ? TVText : PhoneText;

/** Re-exported so a `TextInput` or an animated label can be styled to match. */
export { resolveTextStyle, typeStyle };
