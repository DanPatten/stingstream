import type { Ionicons } from "@expo/vector-icons";

/**
 * The semantic icon registry, split out from `Icon.tsx` so a plain `bun test`
 * spec can read it.
 *
 * `Icon.tsx` imports jotai, the settings atoms and react-native's types, which
 * drags react-native's own `index.js` into a test runner that cannot parse its
 * Flow syntax — so a test that only wants to know "is `transcoding` a real
 * glyph?" could not ask. Same reasoning, and the same split, as
 * `constants/theme.ts` keeping itself free of a runtime react-native import.
 *
 * The `Ionicons` import here is type-only and erases at build time.
 */

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
export const ICONS = {
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
  /** The sidebar's collapse control. Three lines, because that is what people reach for. */
  menu: "menu",
  more: "ellipsis-horizontal",
  check: "checkmark",
  /**
   * A radio, for a row that is one of a set.
   *
   * The old coordinator picker drew its own with the bare characters `●` and `○`, which sit on the
   * text baseline, take the font's own metrics and line up with nothing beside them. These are the
   * same glyphs every other control in the app is drawn from.
   */
  radioOn: "radio-button-on",
  radioOff: "radio-button-off",
  close: "close",
  link: "link",
  /** Leaves the app: a box with an arrow going out of it, the web's own "new window". */
  openExternal: "open-outline",
  share: "share-social",
  invite: "person-add",
  /**
   * Watching something with other people.
   *
   * Not `invite`: that glyph is a person with a `+` on them, which is the
   * picture of *adding an account*, and on the top bar — where the button
   * carries no label — that is the only thing it can be read as. Two people
   * side by side is the room, not the paperwork of joining one.
   */
  watchTogether: "people",
  leave: "exit",
  refresh: "refresh",
  sort: "funnel",
  filter: "options",
  add: "add",
  edit: "pencil",
  delete: "trash",
  /** Setting somebody else's password, on the Users screen. */
  key: "key",
  /**
   * Turning an account off and back on.
   *
   * A pair rather than one glyph that toggles: the button says what pressing it
   * does, and "disable" and "enable" are opposite enough that the same icon for
   * both reads as a state badge instead of an action.
   */
  block: "ban",
  unblock: "checkmark-circle-outline",

  // Direction
  chevronRight: "chevron-forward",
  chevronLeft: "chevron-back",
  chevronDown: "chevron-down",
  chevronUp: "chevron-up",

  // Settings categories
  //
  // One glyph each, and all distinct: the settings navigation lists every one
  // of them in a column, which is exactly the case where a repeated icon stops
  // being shorthand and starts being noise (the same reason library rows use
  // raw Ionicons rather than one "library" glyph -- see `tabIcons.ts`).
  profile: "person",
  display: "color-palette",
  playback: "play-circle",
  servers: "server",
  services: "apps",
  storage: "folder-open",
  quality: "sparkles",
  files: "document-text",
  transcoding: "hardware-chip",
  network: "globe",
  // Not another globe: `network` owns that one, and Network and Domains sit in
  // the same navigation column. A cloud is also the shape of the thing this page
  // sets up.
  domains: "cloud",
  notifications: "notifications",
  plugins: "extension-puzzle",
  diagnostics: "pulse",

  // Identity and status
  user: "person-circle",
  /**
   * The accounts on this server, as a section.
   *
   * Distinct from `user`, which is one person — an avatar fallback, the
   * administrators-only notice. A sidebar row that says "everybody" wants the
   * plural glyph.
   */
  users: "people",
  signOut: "log-out",
  /**
   * A community score. A star, because that is what a score out of ten looks
   * like everywhere else a person has seen one.
   */
  rating: "star",
  warning: "warning",
  error: "alert-circle",
  success: "checkmark-circle",
} satisfies Record<string, keyof typeof Ionicons.glyphMap>;

export type IconName = keyof typeof ICONS;

/** Every semantic name, for a picker or a test that walks the set. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];
