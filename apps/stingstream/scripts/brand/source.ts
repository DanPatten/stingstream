/**
 * The authored source art for the StingStream brand.
 *
 * This replaces the vector `mark.ts` / `wordmark.ts` that came before it. The mark is a
 * rendered image -- overlapping translucent ribbons with an inner glow and gradient
 * falloff -- and there is no fill path that reproduces it, so the pipeline reads pixels
 * rather than path data. `generate.ts` composes every icon, favicon, TV asset and store
 * image from the two pieces below and never re-cuts them.
 *
 * Provenance: one delivered 1254x1254 render (`source/lockup-master.png`) holds the mark
 * above the wordmark, separated by a fully transparent band at y 862..878. The two pieces
 * were cut from it once, at the exact bounds of their own ink:
 *
 *   mark      crop (420, 188)-(820, 862)   400x674
 *   wordmark  crop (200, 879)-(1056, 1030) 856x151
 *
 * Cutting both from the one master is what keeps their relative scale exact, which is
 * what `stackedLockup()` relies on to reproduce the delivered lockup rather than
 * re-invent it. (The separately delivered mark-only render was verified pixel-identical
 * to the master's mark region -- same art, no extra resolution.)
 *
 * Resolution ceiling: 400x674 is the mark's native size and 856x151 the wordmark's. The
 * 1024 icons upscale the mark ~1.25x, invisible on art this soft. The tvOS 2x top-shelf
 * assets push the wordmark ~3.9x and read softer. A larger master render dropped into
 * `source/` (same crop ratios) plus a regenerate is all that would take.
 */

/** Filenames under `assets/brand/source/`, the committed authored art. */
export const SOURCE_FILES = {
  master: "lockup-master.png",
  mark: "mark.png",
  wordmark: "wordmark.png",
} as const;

/** Intrinsic pixel size of each cut piece. The layout maths derives aspect from these. */
export const MARK_SIZE = { width: 400, height: 674 } as const;
export const WORDMARK_SIZE = { width: 856, height: 151 } as const;
export const MASTER_SIZE = { width: 1254, height: 1254 } as const;

/**
 * Where each piece sits inside the master, in master pixels. `stackedLockup()` reads
 * these so the generated stacked lockup is the delivered composition, gap and optical
 * centring included, rather than an approximation of it.
 */
export const MASTER_LAYOUT = {
  mark: { x: 420, y: 188, width: 400, height: 674 },
  wordmark: { x: 200, y: 879, width: 856, height: 151 },
} as const;

/**
 * The mark's gradient, sampled from the art itself: the dominant cyan is #3CE4FC/#30CCFC
 * (hue ~190), it runs through #0C48FC (hue ~225) and tails into violet around hue 270.
 * Two stops are all this is used for -- the web manifest's `theme_color` and the docs --
 * since nothing tints the mark any more.
 *
 * This is deliberately NOT the app's UI accent. `constants/theme.tokens.json` keeps teal
 * (#1FC7B5) as the default accent for buttons, focus rings, tabs and sliders; the logo
 * and the interface are allowed to read as different things.
 */
export const BRAND_ACCENT = { from: "#3CDDFC", to: "#6D5BF7" } as const;

/** The app's darkest surface, and the backdrop every opaque brand asset is flattened onto. */
export const BRAND_BG = "#0B0C0F";

/**
 * Levels applied to the mark's alpha channel to make the monochrome silhouette: alpha
 * below `lo` is dropped (the outer glow halo) and alpha above `hi` goes fully solid (the
 * ribbons), with a linear ramp between. Android throws away the color of a notification
 * icon and keeps only this shape, so it is tuned for 96px legibility rather than fidelity
 * to the render.
 */
export const MONO_ALPHA_LEVELS = { lo: 0.18, hi: 0.72 } as const;

/**
 * Saturation thresholds used to build the light-background wordmark. "Sting" is rendered
 * near-white (#EAECF2) and vanishes on a light ground; "Stream" carries the cyan->violet
 * gradient, whose hue is kept and whose lightness is capped. Measured on the cut art the
 * two do not overlap at all: every achromatic column is <= 363 and every chromatic column
 * is >= 375.
 */
export const WORDMARK_SATURATION = {
  chromatic: 0.35,
  achromatic: 0.12,
} as const;

/** The ink "Sting" is recolored to for the light-background lockup. */
export const WORDMARK_LIGHT_INK = { r: 0x0b, g: 0x0c, b: 0x0f } as const;

/**
 * How far "Stream" is darkened for the light-background lockup.
 *
 * The gradient is the artwork's and used to be carried across untouched, on the
 * grounds that it is the brand. On white it measured 3.22:1 on average and 1.11:1
 * at its lightest -- Dan, looking at the sidebar on the light theme: *"can you make
 * the logo readable?"*. The pale cyan end is simply not ink on a white page.
 *
 * So the hue and the saturation are kept, which is what makes it recognisably the
 * same gradient, and only the *lightness* is capped. `maxLightness` is an HSL L,
 * and `minSaturation` stops a darkened pixel going muddy: pulling lightness down
 * without it turns the cyan grey rather than deep teal.
 *
 * `brand.test.ts` pins the result, so a re-render of the source art that drifts
 * back towards pale fails rather than shipping.
 */
export const WORDMARK_LIGHT_CHROMA = {
  maxLightness: 0.28,
  minSaturation: 0.65,
} as const;
