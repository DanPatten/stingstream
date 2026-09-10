import { Image } from "expo-image";
import { MARK_IMAGE, MARK_MONO_IMAGE } from "@/constants/brandAssets";

export type StingStreamMarkProps = {
  /** Rendered width and height, in dp. The mark is square. */
  size: number;
  /** Tint for `variant="mono"`. Ignored for `variant="gradient"`. Defaults to white. */
  color?: string;
  /** "gradient" (the full-color art, the default) or "mono" (a flat `color` silhouette). */
  variant?: "gradient" | "mono";
};

/**
 * The StingStream mark on its own -- app icon, sidebar/header logo, loading states.
 * See `scripts/brand/source.ts` for where the art comes from.
 *
 * `mono` is a separate image, not a tint of the color one: the mark is a render of
 * overlapping translucent ribbons, and tinting that directly gives a soft grey smear
 * rather than a shape. `mark-mono.png` is the same art with levels applied to its alpha
 * so the ribbons read solid at small sizes; `tintColor` then recolors it.
 *
 * The art is taller than it is wide, so `contentFit="contain"` letterboxes it inside the
 * square `size` box -- the same placement the square viewBox gave before.
 */
export function StingStreamMark({
  size,
  color = "#FFFFFF",
  variant = "gradient",
}: StingStreamMarkProps) {
  const mono = variant === "mono";
  return (
    <Image
      source={mono ? MARK_MONO_IMAGE : MARK_IMAGE}
      style={{ width: size, height: size }}
      contentFit='contain'
      tintColor={mono ? color : undefined}
      // A bundled asset is already decoded; a cross-fade on a logo just makes the shell
      // look like it is still loading.
      transition={0}
    />
  );
}

export default StingStreamMark;
