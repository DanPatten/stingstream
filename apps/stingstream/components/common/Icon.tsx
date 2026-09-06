import { Ionicons } from "@expo/vector-icons";
import { useAtomValue } from "jotai";
import type { StyleProp, TextStyle } from "react-native";
import { DEFAULT_ACCENT, type TextTone, toneColor } from "@/constants/theme";
import { effectiveSettingsAtom } from "@/utils/atoms/settings";

/**
 * One icon set, named for what an icon *means*.
 *
 * The fork mixes Feather, Ionicons and MaterialIcons, sometimes three glyphs
 * from three families in one row — which is why six icons side by side never
 * looked like a set. Everything outside a native header now comes from here;
 * headers keep `HeaderIcon`, which resolves to the platform's own symbol set.
 *
 * Semantic names, not visual ones: swapping the glyph for "watchlist" is a
 * one-line change here rather than a hunt through call sites. Ionicons ships
 * with `@expo/vector-icons` as a bundled font, so this renders identically on
 * web, Android and Android TV with nothing fetched at runtime.
 */
const ICONS = {
  // Navigation
  home: "home",
  search: "search",
  library: "library",
  favorite: "heart",
  watchlist: "bookmark",
  requests: "ticket",
  manage: "options",
  transfers: "swap-vertical",
  settings: "settings",
  sharing: "git-network",
  devices: "phone-portrait",

  // Playback
  play: "play",
  pause: "pause",
  cast: "tv",
  download: "download",

  // Actions
  info: "information-circle",
  more: "ellipsis-horizontal",
  check: "checkmark",
  close: "close",
  link: "link",
  share: "share-social",
  invite: "person-add",
  leave: "exit",
  refresh: "refresh",
  sort: "funnel",
  filter: "options",
  add: "add",
  edit: "pencil",
  delete: "trash",

  // Direction
  chevronRight: "chevron-forward",
  chevronLeft: "chevron-back",
  chevronDown: "chevron-down",
  chevronUp: "chevron-up",

  // Identity and status
  user: "person-circle",
  signOut: "log-out",
  warning: "warning",
  error: "alert-circle",
  success: "checkmark-circle",
} satisfies Record<string, keyof typeof Ionicons.glyphMap>;

export type IconName = keyof typeof ICONS;

/** Every semantic name, for a picker or a test that walks the set. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps {
  name: IconName;
  /** Defaults to 20 — the size that sits beside `body` text. */
  size?: number;
  /** A text tone, so an icon matches the label next to it. Defaults to primary. */
  tone?: TextTone;
  /** An explicit colour, when no tone fits (a poster overlay, a brand mark). */
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
  const accent = useAtomValue(effectiveSettingsAtom).accent ?? DEFAULT_ACCENT;

  return (
    <Ionicons
      name={ICONS[name]}
      size={size}
      color={color ?? toneColor(tone, accent)}
      style={style}
      // An icon with no label is decorative: it sits beside text that already
      // says the same thing, and announcing it twice is worse than not at all.
      accessible={Boolean(accessibilityLabel)}
      accessibilityLabel={accessibilityLabel}
    />
  );
};
