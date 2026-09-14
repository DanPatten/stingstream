/**
 * The picture sizes a quality profile is edited in, and the rules that keep an edit valid.
 *
 * A person has an opinion about how big the picture is, not about `WEBRip-720p` against
 * `HDTV-720p`, so a profile is four switches and the server turns them into each manager's own
 * quality names (`QualityTiers` in StingStream.Core). Nothing here knows those names.
 */

/** Worst first, matching the server. */
export const TIERS = ["sd", "720p", "1080p", "2160p"] as const;
export type Tier = (typeof TIERS)[number];

export interface ProfileDraft {
  tiers: Tier[];
  /** Where upgrading stops. `null` only while no tier is selected. */
  cutoff: Tier | null;
  upgrade: boolean;
}

/** What New starts from: the same as the built-in Medium. */
export const NEW_PROFILE_DRAFT: ProfileDraft = {
  tiers: ["720p", "1080p"],
  cutoff: "1080p",
  upgrade: true,
};

export function isTier(value: unknown): value is Tier {
  return TIERS.includes(value as Tier);
}

/** Known tiers only, each once, worst first. */
export function orderTiers(tiers: readonly unknown[]): Tier[] {
  return TIERS.filter((tier) => tiers.includes(tier));
}

/**
 * Where upgrading should stop for this selection: the current cutoff while it is still allowed,
 * otherwise the best allowed tier, so a profile never upgrades forever.
 */
export function cutoffFor(
  tiers: readonly Tier[],
  cutoff: Tier | null,
): Tier | null {
  if (cutoff && tiers.includes(cutoff)) return cutoff;
  return orderTiers(tiers).at(-1) ?? null;
}

/**
 * Switch one tier on or off. The last one cannot be switched off: a profile that allows nothing is
 * refused by the server, and a disabled chip says so better than an error does.
 */
export function toggleTier(draft: ProfileDraft, tier: Tier): ProfileDraft {
  const on = draft.tiers.includes(tier);
  if (on && draft.tiers.length === 1) return draft;
  const tiers = orderTiers(
    on ? draft.tiers.filter((t) => t !== tier) : [...draft.tiers, tier],
  );
  return { ...draft, tiers, cutoff: cutoffFor(tiers, draft.cutoff) };
}

/** A draft from a profile as the server reports it. */
export function draftOf(profile: {
  Tiers?: string[] | null;
  CutoffTier?: string | null;
  UpgradeAllowed?: boolean | null;
}): ProfileDraft {
  const tiers = orderTiers(profile.Tiers ?? []);
  return {
    tiers,
    cutoff: cutoffFor(
      tiers,
      isTier(profile.CutoffTier) ? profile.CutoffTier : null,
    ),
    upgrade: profile.UpgradeAllowed ?? true,
  };
}
