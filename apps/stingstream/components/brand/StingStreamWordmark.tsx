import { Image } from "expo-image";
import { View } from "react-native";
import {
  BRAND_ASPECTS,
  MARK_IMAGE,
  WORDMARK_IMAGE,
  WORDMARK_LIGHT_IMAGE,
} from "@/constants/brandAssets";
import { horizontalLayout, type Rect, stackedLayout } from "./wordmarkLayout";

export type StingStreamWordmarkProps = {
  /** Rendered height, in dp. Width is derived from the layout's own aspect ratio. */
  height: number;
  /** "horizontal" (mark beside the text, the default) or "stacked" (mark above the text). */
  layout?: "horizontal" | "stacked";
  /**
   * Which ground the lockup is sitting on. "Sting" is rendered near-white and vanishes on
   * a light background, so "light" swaps in the variant with it recolored dark. The app
   * is dark throughout, hence the default.
   */
  theme?: "dark" | "light";
};

/**
 * The mark plus the "StingStream" wordmark, laid out as one lockup. Both halves are
 * bundled images placed by `wordmarkLayout`, which `scripts/brand/generate.ts` imports
 * too -- so the lockup the app draws and the lockup baked into the TV banner and the
 * store graphics come from one set of numbers.
 */
export function StingStreamWordmark({
  height,
  layout = "horizontal",
  theme = "dark",
}: StingStreamWordmarkProps) {
  const content =
    layout === "stacked"
      ? stackedLayout(BRAND_ASPECTS)
      : horizontalLayout(BRAND_ASPECTS);
  const scale = height / content.height;
  const place = (rect: Rect) =>
    ({
      position: "absolute",
      left: rect.x * scale,
      top: rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    }) as const;

  return (
    <View style={{ width: content.width * scale, height }}>
      {/* "fill" rather than "contain": every rect is built at its image's own aspect. */}
      <Image
        source={MARK_IMAGE}
        style={place(content.mark)}
        contentFit='fill'
        transition={0}
      />
      <Image
        source={theme === "light" ? WORDMARK_LIGHT_IMAGE : WORDMARK_IMAGE}
        style={place(content.wordmark)}
        contentFit='fill'
        transition={0}
      />
    </View>
  );
}

export default StingStreamWordmark;
