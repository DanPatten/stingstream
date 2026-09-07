/**
 * Splits `total` across the given weights so the parts sum to exactly
 * `total` (largest-remainder apportionment). Entries are passed in priority
 * order, which is how remainder ties are broken.
 *
 * The hero always aims for a fixed number of slides, so a group the viewer
 * filtered out has to give its share to the groups that remain rather than
 * simply shortening the carousel — that is the whole reason this is
 * apportionment and not `Math.round(total / groups)`. Lifted out of
 * `HomeHeroCarousel.tsx` so the rule can be tested as plain arithmetic, with
 * no window, no query and no React.
 */
export const apportion = <K extends string>(
  total: number,
  weights: [K, number][],
): Record<K, number> => {
  const sum = weights.reduce((acc, [, weight]) => acc + weight, 0);
  const result = {} as Record<K, number>;
  if (sum <= 0) {
    for (const [key] of weights) result[key] = 0;
    return result;
  }

  const remainders: { key: K; remainder: number }[] = [];
  let assigned = 0;
  for (const [key, weight] of weights) {
    const exact = (total * weight) / sum;
    const floor = Math.floor(exact);
    result[key] = floor;
    assigned += floor;
    remainders.push({ key, remainder: exact - floor });
  }

  // Hand out what rounding left over, biggest fractional part first. Sort is
  // stable, so equal remainders fall to whichever came first in `weights`.
  const leftover = total - assigned;
  remainders
    .sort((a, b) => b.remainder - a.remainder)
    .slice(0, Math.max(leftover, 0))
    .forEach(({ key }) => {
      result[key] += 1;
    });
  return result;
};
