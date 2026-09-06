import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import {
  BRAND_ACCENT_FROM,
  BRAND_ACCENT_TO,
  MARK_PATH_D,
  WORDMARK_TEXT_D,
} from "@/constants/brandPaths";
import { horizontalLayout, stackedLayout } from "./wordmarkLayout";

export type StingStreamWordmarkProps = {
  /** Rendered height, in dp. Width is derived from the layout's own aspect ratio. */
  height: number;
  /** Fill for the wordmark text. The mark itself always keeps the brand gradient. Defaults to white. */
  color?: string;
  /** "horizontal" (mark beside the text, the default) or "stacked" (mark above the text). */
  layout?: "horizontal" | "stacked";
};

/**
 * The mark plus the "StingStream" wordmark, laid out as one lockup. The wordmark text
 * is outlined glyph paths baked from Inter SemiBold (see `scripts/brand/wordmark.ts`) --
 * it never depends on a font being loaded at render time.
 */
export function StingStreamWordmark({
  height,
  color = "#FFFFFF",
  layout = "horizontal",
}: StingStreamWordmarkProps) {
  const content = layout === "stacked" ? stackedLayout() : horizontalLayout();
  const width = height * (content.width / content.height);
  return (
    <Svg
      width={width}
      height={height}
      viewBox={`0 0 ${content.width} ${content.height}`}
    >
      <Defs>
        <LinearGradient
          id='stingstream-wordmark-gradient'
          x1='0'
          y1='0'
          x2='1'
          y2='1'
        >
          <Stop offset='0' stopColor={BRAND_ACCENT_FROM} />
          <Stop offset='1' stopColor={BRAND_ACCENT_TO} />
        </LinearGradient>
      </Defs>
      <Path
        d={MARK_PATH_D}
        fill='url(#stingstream-wordmark-gradient)'
        transform={content.markTransform}
      />
      <Path
        d={WORDMARK_TEXT_D}
        fill={color}
        transform={content.textTransform}
      />
    </Svg>
  );
}

export default StingStreamWordmark;
