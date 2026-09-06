import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import {
  BRAND_ACCENT_FROM,
  BRAND_ACCENT_TO,
  MARK_PATH_D,
  MARK_VIEWBOX,
} from "@/constants/brand/paths";

export type StingStreamMarkProps = {
  /** Rendered width and height, in dp. The mark is square. */
  size: number;
  /** Fill for `variant="mono"`. Ignored for `variant="gradient"`. Defaults to white. */
  color?: string;
  /** "gradient" (the brand teal gradient, the default) or "mono" (a flat `color` fill). */
  variant?: "gradient" | "mono";
};

/**
 * The StingStream mark on its own -- app icon, sidebar/header logo, loading states.
 * See `scripts/brand/mark.ts` for how the path was authored.
 */
export function StingStreamMark({
  size,
  color = "#FFFFFF",
  variant = "gradient",
}: StingStreamMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={MARK_VIEWBOX}>
      {variant === "gradient" ? (
        <Defs>
          <LinearGradient
            id='stingstream-mark-gradient'
            x1='0'
            y1='0'
            x2='1'
            y2='1'
          >
            <Stop offset='0' stopColor={BRAND_ACCENT_FROM} />
            <Stop offset='1' stopColor={BRAND_ACCENT_TO} />
          </LinearGradient>
        </Defs>
      ) : null}
      <Path
        d={MARK_PATH_D}
        fill={
          variant === "gradient" ? "url(#stingstream-mark-gradient)" : color
        }
      />
    </Svg>
  );
}

export default StingStreamMark;
