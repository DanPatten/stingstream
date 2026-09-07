import { storage } from "@/utils/mmkv";

/**
 * The Search screen's "recent searches" chips.
 *
 * Newest first, capped at `RECENT_SEARCHES_MAX`, deduplicated case
 * insensitively so searching "Nosferatu" twice doesn't leave two chips. Kept
 * as plain functions over MMKV rather than an atom: the screen already has to
 * mirror the result into its own `useState` to re-render on write (MMKV is
 * not itself observable the way Jotai is), and that mirroring is one line at
 * the call site versus a whole atom family for a value one screen reads.
 *
 * The two constants below would ordinarily live in `constants/Values.ts` (a
 * storage key is exactly the kind of thing `docs/conventions/constants.md`
 * asks for) — but that file pulls in `react-native` for `TAB_HEIGHT`'s
 * `Platform.OS` check, and `bun:test` cannot parse plain `react-native`'s own
 * entry point at all (a Flow-typed file, not a native-module problem
 * `test-utils/mmkv.ts`'s stub could paper over). Importing it here would make
 * this module — otherwise pure MMKV reads and writes — untestable under
 * `bun:test`. Single-owner, single-file values, so keeping them local costs
 * nothing a second definition would ever need to catch up with.
 */
const RECENT_SEARCHES_STORAGE_KEY = "recentSearches";
const RECENT_SEARCHES_MAX = 8;

export function getRecentSearches(): string[] {
  const raw = storage.getString(RECENT_SEARCHES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    // A corrupt or pre-format value is no worse than no history at all.
    return [];
  }
}

/** Records a completed search and returns the updated list. */
export function addRecentSearch(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return getRecentSearches();

  const withoutDuplicate = getRecentSearches().filter(
    (existing) => existing.toLowerCase() !== trimmed.toLowerCase(),
  );
  const next = [trimmed, ...withoutDuplicate].slice(0, RECENT_SEARCHES_MAX);
  storage.set(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Empties the list and returns it (always `[]`), so a caller can set state in one line. */
export function clearRecentSearches(): string[] {
  storage.remove(RECENT_SEARCHES_STORAGE_KEY);
  return [];
}
