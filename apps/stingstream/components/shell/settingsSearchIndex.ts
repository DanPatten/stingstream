import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import {
  buildSettingsCategories,
  flattenCategories,
  type SettingsCategory,
} from "./buildSettingsCategories";

/**
 * Every settings control, by name and by the words somebody would actually type.
 *
 * The categories alone are not enough for this. "Transcode" is not the name of
 * any category — the page is called *Transcoding & hardware* and the control is
 * called *Hardware acceleration* — and somebody hunting for NVENC types
 * "nvenc", which appears nowhere on any screen. A page-level index would answer
 * both with "here is a page, look through it", which is the state Settings was
 * already in.
 *
 * ## Why one table rather than each pane declaring its own
 *
 * A pane that exports its own entries drifts the moment somebody adds a control
 * and forgets, and nothing fails. One table can be tested: every entry names a
 * real category, every category contributes at least one entry, and every entry
 * has both of its strings. The cost is that a label here and the label on the
 * control are two strings that could disagree — so the entries deliberately
 * describe *what you are looking for* rather than mirroring a caption, and the
 * `focus` id takes you to the control itself, which then speaks for itself.
 *
 * ## Strings
 *
 * `home.settings.search.label.<id>` and `home.settings.search.kw.<id>`, both
 * read dynamically, which is why the i18n checker treats the whole
 * `home.settings.search.` prefix as used. Keywords are a comma-separated list
 * in one key so a translator can replace the whole set for their language —
 * "captions" and "Untertitel" are not a word-for-word pair.
 */

export interface SettingsSearchEntry {
  /** Stable id: the `?focus=` value, the React key and the `testID` suffix. */
  id: string;
  categoryKey: string;
  categoryLabel: string;
  label: string;
  keywords: string[];
  /** Where selecting it goes, section and focus target included. */
  href: string;
}

type Translate = (key: string) => string;

interface Control {
  id: string;
  category: string;
  /** The section of a tabbed pane, when it has one. */
  tab?: string;
  /**
   * Somewhere other than its own category — Servers offering "invite a person",
   * which really is on Users & access.
   */
  route?: string;
}

/**
 * The table.
 *
 * Ordered by category so a reviewer can see at a glance what a page is claimed
 * to contain, which is the other thing this file is good for: a category with
 * one entry is usually a category that has not been finished.
 */
const CONTROLS: Control[] = [
  // Profile
  { id: "display-name", category: "profile" },
  { id: "avatar", category: "profile" },
  { id: "password", category: "profile" },
  { id: "passkeys", category: "profile" },
  { id: "link-device", category: "profile" },
  { id: "sign-out", category: "profile" },

  // Interface & display
  { id: "theme", category: "appearance" },
  { id: "app-language", category: "appearance" },
  { id: "home-layout", category: "appearance" },
  { id: "hidden-libraries", category: "appearance" },

  // Playback & subtitles
  { id: "video-player", category: "playback", tab: "playback" },
  { id: "playback-quality", category: "playback", tab: "playback" },
  { id: "gestures", category: "playback", tab: "playback" },
  { id: "segment-skip", category: "playback", tab: "playback" },
  { id: "chromecast", category: "playback", tab: "playback" },
  { id: "audio-language", category: "playback", tab: "audio" },
  { id: "subtitle-language", category: "playback", tab: "audio" },
  { id: "subtitle-style", category: "playback", tab: "audio" },
  { id: "music-cache", category: "playback", tab: "music" },

  // About
  { id: "app-version", category: "about" },
  { id: "device-storage", category: "about" },
  { id: "app-logs", category: "about" },

  // Servers
  { id: "linked-servers", category: "servers" },
  { id: "my-server", category: "servers" },
  { id: "this-device", category: "servers" },
  { id: "invite-person", category: "servers", route: "/settings/users" },

  // Domains. Two rows for two questions: "what is my address" lands on the
  // field, and anything about tunnels or forwarding lands on the block that
  // sets one up -- which is most of what somebody arrives here wanting, and is
  // not a thing they would think to search for under "domain".
  { id: "public-domain", category: "domains" },
  { id: "cloudflare-tunnel", category: "domains" },

  // Users & access
  { id: "accounts", category: "users", tab: "people" },
  { id: "invitations", category: "users", tab: "people" },
  { id: "library-access", category: "users", tab: "people" },
  { id: "request-quota", category: "users", tab: "policy" },
  { id: "trusted-requesters", category: "users", tab: "policy" },

  // Media services
  { id: "indexers", category: "services" },
  { id: "download-clients", category: "services" },
  { id: "arr-sync", category: "services" },

  // Libraries. One row per library, each carrying the switch every "downloading
  // is not set up" notice is trying to reach: turning a library on is what
  // starts the manager that fills it.
  { id: "libraries", category: "storage" },
  { id: "scan-delay", category: "storage" },
  { id: "scan-concurrency", category: "storage" },

  // Quality & formats
  { id: "quality-profiles", category: "quality" },
  { id: "quality-cutoff", category: "quality" },

  // Files & naming
  { id: "movie-naming", category: "files" },
  { id: "episode-naming", category: "files" },

  // Transcoding & hardware
  { id: "hardware-acceleration", category: "transcoding" },
  { id: "encoding-threads", category: "transcoding" },
  { id: "transcode-path", category: "transcoding" },
  { id: "remote-bitrate", category: "transcoding" },

  // Network & remote access
  { id: "remote-access", category: "network" },
  { id: "port-forwarding", category: "network" },
  { id: "public-port", category: "network" },
  { id: "base-url", category: "network" },
  { id: "known-proxies", category: "network" },
  { id: "https", category: "network" },
  { id: "certificate", category: "network" },

  // Notifications
  { id: "webhooks", category: "notifications" },

  // Plugins
  { id: "streamystats", category: "plugins" },

  // Logs & status
  { id: "server-status", category: "diagnostics", tab: "status" },
  { id: "server-logs", category: "diagnostics", tab: "logs" },
];

const hrefFor = (control: Control, category: SettingsCategory): string => {
  const base = control.route ?? category.route;
  const query = [
    control.tab ? `tab=${control.tab}` : null,
    `focus=${control.id}`,
  ]
    .filter(Boolean)
    .join("&");
  return `${base}?${query}`;
};

/**
 * The index for one account.
 *
 * Built from `buildSettingsCategories`, so a control in a category a member
 * cannot see is simply absent — the search cannot offer somebody a page that
 * would answer "this needs an administrator account".
 */
export function buildSettingsSearchIndex(
  user: UserDto | null | undefined,
  t: Translate,
): SettingsSearchEntry[] {
  const categories = new Map(
    flattenCategories(buildSettingsCategories(user, t)).map((category) => [
      category.key,
      category,
    ]),
  );

  return CONTROLS.flatMap((control) => {
    const category = categories.get(control.category);
    if (!category) return [];

    return [
      {
        id: control.id,
        categoryKey: category.key,
        categoryLabel: category.label,
        label: t(`home.settings.search.label.${control.id}`),
        keywords: t(`home.settings.search.kw.${control.id}`)
          .split(",")
          .map((word) => word.trim().toLowerCase())
          .filter(Boolean),
        href: hrefFor(control, category),
      },
    ];
  });
}

/** How many matches a dropdown can show without becoming a page of its own. */
export const SETTINGS_SEARCH_LIMIT = 8;

/**
 * Rank, most obviously right first.
 *
 * A label the query starts beats a label that merely contains it, which beats a
 * keyword, which beats the category name. Without the ordering, typing "sub"
 * offered *Subtitle style* and *Request quota* — the latter because a keyword
 * for it happens to contain "sub" — with no reason to prefer either.
 */
export function searchSettings(
  index: SettingsSearchEntry[],
  query: string,
): SettingsSearchEntry[] {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return [];

  const scored = index
    .map((entry) => ({ entry, score: score(entry, term) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label),
    );

  return scored.slice(0, SETTINGS_SEARCH_LIMIT).map((row) => row.entry);
}

const score = (entry: SettingsSearchEntry, term: string): number => {
  const label = entry.label.toLowerCase();
  if (label.startsWith(term)) return 4;
  if (label.includes(term)) return 3;
  if (entry.keywords.some((word) => word.startsWith(term))) return 2;
  if (entry.keywords.some((word) => word.includes(term))) return 1.5;
  if (entry.categoryLabel.toLowerCase().includes(term)) return 1;
  return 0;
};

/** Every control id, for a test that walks the set. */
export const SETTINGS_CONTROL_IDS = CONTROLS.map((control) => control.id);
