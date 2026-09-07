/**
 * The marketing-version + build-number formatting for Settings' version pill (`ProfileHeader.tsx`,
 * `AboutSection.tsx`), kept free of platform imports — same reasoning as `utils/atoms/
 * settingsOverrides.ts` — so `pickVersion` and `formatVersionLabel` are unit-testable without an
 * RN/Expo runtime. The actual candidate values (`expo-application`, `expo-constants`,
 * `process.env.EXPO_PUBLIC_APP_VERSION`) differ by platform and are not pure; `ProfileHeader.tsx`
 * supplies them.
 */

/**
 * The first candidate that is a non-empty, non-whitespace string, or `null` if none are.
 *
 * Never resolves to a hardcoded literal itself — a caller that wants one as a last resort has to
 * pass it explicitly as a candidate, which `appVersionLabel()` deliberately never does: a stale or
 * wrong-but-present value beats a fabricated one, but a fabricated one is worse than "N/A".
 */
export function pickVersion(
  candidates: ReadonlyArray<string | null | undefined>,
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

/** "v0.2.0 (2)" with a build number, "v0.2.0" without one, "N/A" with no version at all. */
export function formatVersionLabel(
  version: string | null,
  build: string | null,
): string {
  if (!version) return "N/A";
  return build ? `v${version} (${build})` : `v${version}`;
}
