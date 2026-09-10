/**
 * Ready-made quality profiles, and the format groups that edit one.
 *
 * The old editor asked somebody to type a name and then tick boxes from a list of nineteen
 * strings like `Bluray-1080p`, `WEBRip-720p` and `Remux-2160p` — vocabulary from a downloader's
 * settings screen, not from anything a person watching television has an opinion about. Most
 * people want one of four things, so those four are offered by name and the list of nineteen
 * becomes something you only meet if you go looking.
 *
 * **No free text anywhere.** A profile's name is its identity in the managers it is written to
 * and cannot be changed afterwards, so a typed one is a typo somebody lives with. Presets carry
 * their own names; the shortcuts below add and remove whole formats; nothing here has a keyboard.
 *
 * Everything is matched against the vocabulary the server actually reported rather than
 * hard-coded, because the two managers do not offer identical lists and both grow new formats
 * between releases. A preset asks for "the 1080p ones" and gets whatever this server has.
 */

/** A group of formats, as a person would ask for it. */
export type FormatGroup = "sd" | "hd720" | "hd1080" | "uhd" | "remux";

/**
 * Which vocabulary entries belong to each group.
 *
 * Substring matching on the resolution, which is what every one of these names carries: `SDTV`,
 * `WEBDL-720p`, `Bluray-1080p`, `Remux-2160p`. A name can be in two groups at once — `Remux-1080p`
 * is both 1080p and a remux — and that is correct: they are two questions about the same file,
 * "how big is the picture" and "is it an untouched disc rip".
 */
const MATCHERS: Record<FormatGroup, RegExp> = {
  sd: /(^|[^0-9])(sdtv|dvd|480p|576p)/i,
  hd720: /720p/i,
  hd1080: /1080p/i,
  uhd: /2160p/i,
  remux: /remux/i,
};

/** Every vocabulary entry in this group, in the order the server listed them. */
export function inGroup(
  vocabulary: readonly string[],
  group: FormatGroup,
): string[] {
  return vocabulary.filter((name) => MATCHERS[group].test(name));
}

/** Which groups this server can actually offer. */
export function availableGroups(vocabulary: readonly string[]): FormatGroup[] {
  return (Object.keys(MATCHERS) as FormatGroup[]).filter(
    (group) => inGroup(vocabulary, group).length > 0,
  );
}

/** One ready-made profile. */
export interface QualityPreset {
  /** Stable key for translations and testIDs. */
  key: string;
  /** The profile's name on the server. Never translated: it is an identity, not a label. */
  name: string;
  /** The groups it allows. */
  groups: FormatGroup[];
  /**
   * Stop upgrading once this group is reached. Its *best* member becomes the cutoff.
   *
   * A profile with no cutoff keeps replacing a perfectly good file with a marginally better one
   * forever, which is how a server ends up re-downloading the same film all month.
   */
  cutoff: FormatGroup;
}

/**
 * The four, in the order they are offered.
 *
 * "Everyday" leads and is the one to recommend: 1080p is what almost everything is released at,
 * and pairing it with 720p means a title that has no 1080p release still arrives instead of
 * silently never arriving. Remux is excluded from it deliberately — a remux is the whole disc, ten
 * to twenty times the size, and nobody who has not asked for that wants it by default.
 */
export const PRESETS: QualityPreset[] = [
  {
    key: "everyday",
    name: "Everyday",
    groups: ["hd720", "hd1080"],
    cutoff: "hd1080",
  },
  {
    key: "high",
    name: "High quality",
    groups: ["hd1080", "remux"],
    cutoff: "remux",
  },
  {
    key: "uhd",
    name: "4K",
    groups: ["hd1080", "uhd"],
    cutoff: "uhd",
  },
  {
    key: "anything",
    name: "Anything",
    groups: ["sd", "hd720", "hd1080", "uhd"],
    cutoff: "hd1080",
  },
];

/** What a preset becomes for this server: the qualities to allow, and where to stop upgrading. */
export interface ResolvedPreset {
  allowed: string[];
  cutoff: string;
}

/**
 * Turn a preset into the concrete qualities this server offers.
 *
 * `null` when the server has none of them, which is not a failure worth an error: it means the
 * vocabulary has not arrived yet, or this server genuinely cannot fetch anything in that range,
 * and either way the right thing is not to offer the preset.
 */
export function resolvePreset(
  preset: QualityPreset,
  vocabulary: readonly string[],
): ResolvedPreset | null {
  const allowed: string[] = [];
  for (const name of vocabulary) {
    if (preset.groups.some((group) => MATCHERS[group].test(name))) {
      allowed.push(name);
    }
  }
  if (allowed.length === 0) return null;

  // The cutoff is the best member of the cutoff group that this profile actually allows. The
  // vocabulary arrives worst-first, so that is the last one — and falling back to the best allowed
  // quality keeps a profile whose cutoff group is missing from upgrading forever.
  const inCutoff = allowed.filter((name) => MATCHERS[preset.cutoff].test(name));
  const cutoff = (inCutoff.length > 0 ? inCutoff : allowed).at(-1);
  return cutoff ? { allowed, cutoff } : null;
}

/** Whether a profile already on the server matches this preset, so it is not offered twice. */
export function isPresetPresent(
  preset: QualityPreset,
  existingNames: readonly string[],
): boolean {
  return existingNames.some(
    (name) => name.trim().toLowerCase() === preset.name.toLowerCase(),
  );
}
