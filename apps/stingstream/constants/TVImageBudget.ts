/**
 * What the TV build is allowed to spend on images.
 *
 * A Google TV dongle has 1.5–2 GB of RAM and runs the app alongside libmpv and
 * MediaCodec. expo-image's memory cache is unbounded by default, so browsing a
 * few rows of 1920-wide backdrops pins a couple of hundred megabytes of decoded
 * ARGB in RAM and the system kills the app mid-playback. Every number here is a
 * ceiling, not a target.
 *
 * The rule that matters most is `diskOnlyAboveBytes`: anything whose *decoded*
 * size crosses it must be requested with `cachePolicy="disk"`, so it is read
 * back from disk on the next focus rather than held in RAM. Backdrops, the hero
 * image and logos are all above the line. Posters are not.
 *
 * Acceptance for the TV pass measures this: `dumpsys meminfo org.stingstream.app`
 * PSS must grow by less than 40 MB after scrolling five rows.
 */
export const TVImageBudget = {
  /** expo-image `maxMemoryCost`, in bytes of decoded bitmap (ARGB = 4 B/px). */
  memoryCacheBytes: 24 * 1024 * 1024,

  /** expo-image `maxDiskSize`. Disk is cheap; this is about avoiding refetches. */
  diskCacheBytes: 200 * 1024 * 1024,

  /** Widest backdrop we ever ask the server for. One 1920x1080 = ~8 MB decoded. */
  backdropWidth: 1920,

  /**
   * Largest multiple of a card's on-screen width we request for its poster.
   * 2x covers the 1.05 focus scale and a 4K panel without decoding four times
   * the pixels we can show.
   */
  posterDecodeMultiplier: 2,

  /** Logos are wordmarks; past this height the extra rows are invisible. */
  logoMaxHeight: 200,

  /** Above this decoded size, an image is disk-cached only, never pinned in RAM. */
  diskOnlyAboveBytes: 1 * 1024 * 1024,
} as const;

/** Bytes an ARGB8888 bitmap of these dimensions occupies once decoded. */
export const estimateDecodedBytes = (width: number, height: number): number =>
  Math.max(0, Math.round(width)) * Math.max(0, Math.round(height)) * 4;

/**
 * The `cachePolicy` an image of this decoded size is allowed on TV.
 *
 * Call it rather than guessing: the threshold moves as the budget does, and the
 * screens that got this wrong were the ones that hardcoded "memory-disk".
 */
export const tvCachePolicyForDecodedBytes = (
  decodedBytes: number,
): "disk" | "memory-disk" =>
  decodedBytes > TVImageBudget.diskOnlyAboveBytes ? "disk" : "memory-disk";

/** Convenience wrapper for callers that know the pixel dimensions. */
export const tvCachePolicyForSize = (
  width: number,
  height: number,
): "disk" | "memory-disk" =>
  tvCachePolicyForDecodedBytes(estimateDecodedBytes(width, height));
