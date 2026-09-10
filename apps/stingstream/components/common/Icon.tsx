import { Ionicons } from "@expo/vector-icons";
import { useAtomValue } from "jotai";
import type { StyleProp, TextStyle } from "react-native";
import {
  DEFAULT_THEME,
  type TextTone,
  type ThemeName,
  themePalette,
  toneColor,
} from "@/constants/theme";
import { effectiveSettingsAtom } from "@/utils/atoms/settings";
import { ICONS, type IconName } from "./iconNames";

/**
 * One glyph, named for what it *means*.
 *
 * The registry itself lives in `iconNames.ts` — see the note there — and is
 * re-exported from here because that is where every call site already looks
 * for `IconName`.
 */
export { ICON_NAMES, ICONS, type IconName } from "./iconNames";

export interface IconProps {
  name: IconName;
  /** Defaults to 20 — the size that sits beside `body` text. */
  size?: number;
  /** A text tone, so an icon matches the label next to it. Defaults to primary. */
  tone?: TextTone;
  /** An explicit color, when no tone fits (a poster overlay, a brand mark). */
  color?: string;
  style?: StyleProp<TextStyle>;
  /** Screen-reader label. Icons without one are decorative and hidden. */
  accessibilityLabel?: string;
}

export const Icon: React.FC<IconProps> = ({
  name,
  size = 20,
  tone = "primary",
  color,
  style,
  accessibilityLabel,
}) => {
  const palette = themePalette(
    (useAtomValue(effectiveSettingsAtom).theme ?? DEFAULT_THEME) as ThemeName,
  );

  return (
    <Ionicons
      name={ICONS[name]}
      size={size}
      color={color ?? toneColor(tone, palette)}
      style={style}
      // An icon with no label is decorative: it sits beside text that already
      // says the same thing, and announcing it twice is worse than not at all.
      accessible={Boolean(accessibilityLabel)}
      accessibilityLabel={accessibilityLabel}
    />
  );
};
