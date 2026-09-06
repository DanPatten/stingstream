# TV Horizontal Padding Standard

**Date**: 2026-01-25, rewritten 2026-09-06
**Category**: tv
**Key files**: `constants/TVSizes.ts`, `components/tv/TVNavRail.tsx`

## Detail

There is one horizontal padding on TV and one left inset, both in
`constants/TVSizes.ts`. Do not write a number.

- **Right, and anywhere the rail is not**: `sizes.padding.horizontal`.
- **Left**: `sizes.layout.contentInsetLeft` — the collapsed navigation rail plus
  that same gutter. The rail is an absolute overlay, so a screen that pads its
  left edge by anything less puts focusable content underneath it.
- **Top**: `sizes.layout.contentInsetTop`. There is no top bar any more; the
  screens that reserved 100 px (Home, Search, Settings) or 145 px (the hero's
  tvOS menu allowance) for one no longer do.

Before this there were three: 60 in the library grid, 80 in the home rows, and
`scaleSize(80)` on the details page, which is why nothing on one TV screen ever
lined up with anything on the screen before it. The old `TV_SCALE_PADDING = 20`
was already gone; `TV_HORIZONTAL_PADDING = 60` and `TOP_PADDING` went with this
change.
