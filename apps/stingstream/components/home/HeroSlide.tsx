import { LinearGradient } from "expo-linear-gradient";
import { useTranslation } from "react-i18next";
import { type ImageStyle, View } from "react-native";
import { Button } from "@/components/Button";
import { Image } from "@/components/common/ServerImage";
import { Text } from "@/components/common/Text";
import { type BreakpointName, radius, rgba, tokens } from "@/constants/theme";
import type { HeroSlide as HeroSlideData } from "@/hooks/useHeroItems";
import { useTheme } from "@/hooks/useTheme";

export interface HeroSlideProps {
  slide: HeroSlideData;
  width: number;
  height: number;
  breakpoint: BreakpointName;
  /** Page gutter, so the content lines up with the rows underneath. */
  gutter: number;
  /**
   * Whether this is the slide on screen.
   *
   * The carousel keeps every slide mounted so it can animate between them, so
   * without this the page has ten synopses and ten "Play" buttons in its
   * accessibility tree and a screen reader reads the whole library before
   * reaching the first row. Only the visible one is exposed.
   */
  isActive: boolean;
  onPressPlay: () => void;
  onPressInfo: () => void;
}

/**
 * How much of the hero the text block is allowed to cross.
 *
 * On a phone the picture is behind the words whatever we do. On a wide screen
 * the point of the backdrop is that you can still see it, so the copy stops
 * around the left half and the artwork keeps the rest.
 */
const CONTENT_FRACTION: Record<BreakpointName, number> = {
  compact: 1,
  medium: 0.62,
  expanded: 0.48,
};

/** Logo height by breakpoint — a wordmark, not a title, so it is sized by eye. */
const LOGO_HEIGHT: Record<BreakpointName, number> = {
  compact: 56,
  medium: 76,
  expanded: 92,
};

/**
 * A logo is a transparent PNG whose ink can be any color at all, and several
 * of them are near-black title cards that vanish into a dark backdrop —
 * "The Cabinet of Dr. Caligari" is exactly that. `drop-shadow` follows the
 * alpha channel, so it traces the lettering rather than boxing the image the
 * way a `shadow*`/`box-shadow` would.
 *
 * Cast because `filter` is a real style on this React Native version but is
 * not yet in the `ImageStyle` type; it is ignored where it is not supported,
 * which is the right failure (a legible-enough logo, not a crash).
 */
const LOGO_SHADOW = {
  filter: "drop-shadow(0px 2px 10px rgba(0,0,0,0.85))",
} as unknown as ImageStyle;

/**
 * A single hero slide: the backdrop, the three scrims over it, and the block
 * of copy and controls in the bottom-left corner.
 *
 * The scrims are lifted from `TVHeroCarousel.tsx`, which had already solved
 * this: one vertical wash up from the bottom so the copy has a floor, one
 * short wash down from the top so a bright sky does not fight the header, and
 * one horizontal wash in from the left so the words sit on something dark
 * regardless of what the photograph happens to be doing there. Text over an
 * arbitrary image has no contrast guarantee at all without them.
 */
export const HeroSlide: React.FC<HeroSlideProps> = ({
  slide,
  width,
  height,
  breakpoint,
  gutter,
  isActive,
  onPressPlay,
  onPressInfo,
}) => {
  const { t } = useTranslation();
  const { color, accent } = useTheme();
  const isCompact = breakpoint === "compact";
  const isResuming = (slide.progress ?? 0) > 0;
  const contentWidth = Math.max(
    160,
    Math.round(width * CONTENT_FRACTION[breakpoint]) - gutter * 2,
  );
  const badges = slide.badges.join("  ·  ");

  return (
    <View
      aria-hidden={!isActive}
      importantForAccessibility={isActive ? "auto" : "no-hide-descendants"}
      style={{ width, height, overflow: "hidden" }}
    >
      {slide.backdropUrl ? (
        <Image
          source={{ uri: slide.backdropUrl }}
          // The alt text belongs to the title beside it, not to the picture:
          // announcing "backdrop for X" and then reading X is a stutter.
          accessibilityElementsHidden
          importantForAccessibility='no-hide-descendants'
          style={{ position: "absolute", width: "100%", height: "100%" }}
          contentFit='cover'
          // Backdrops are large but there are only ten of them and they are
          // paged through repeatedly; keeping them warm is the difference
          // between a hero that crossfades and one that flashes black.
          cachePolicy='memory-disk'
          transition={tokens.motion.base}
        />
      ) : null}

      {/* A floor under the whole stack, so a slide with no artwork is a dark
          panel with legible copy rather than whatever is behind the page. */}
      <View
        pointerEvents='none'
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          backgroundColor: rgba(color.bg["0"], 0.15),
        }}
      />

      <LinearGradient
        pointerEvents='none'
        colors={["transparent", "rgba(0,0,0,0.55)", "rgba(0,0,0,0.95)"]}
        locations={[0, 0.5, 1]}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "72%",
        }}
      />
      <LinearGradient
        pointerEvents='none'
        colors={["rgba(0,0,0,0.45)", "transparent"]}
        locations={[0, 1]}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: "35%",
        }}
      />
      <LinearGradient
        pointerEvents='none'
        colors={["rgba(0,0,0,0.9)", "rgba(0,0,0,0.55)", "transparent"]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: isCompact ? "100%" : "70%",
        }}
      />

      <View
        style={{
          position: "absolute",
          left: gutter,
          bottom: isCompact ? 20 : 28,
          width: contentWidth,
        }}
      >
        <View
          style={{
            alignSelf: "flex-start",
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: radius.pill,
            backgroundColor: rgba("#FFFFFF", 0.16),
            marginBottom: 10,
          }}
        >
          {/* `caption`, not `micro`: 11 px white on an arbitrary photograph is
              the one place the smallest step on the scale stops being legible,
              and the sweep flags anything under 12 px for the same reason. */}
          <Text
            variant='caption'
            weight='semibold'
            style={{ color: "#FFFFFF" }}
          >
            {slide.label}
          </Text>
        </View>

        {slide.logoUrl ? (
          <Image
            source={{ uri: slide.logoUrl }}
            accessibilityLabel={slide.title}
            style={[
              {
                height: LOGO_HEIGHT[breakpoint],
                width: Math.min(contentWidth, isCompact ? 240 : 360),
                marginBottom: 8,
              },
              LOGO_SHADOW,
            ]}
            contentFit='contain'
            contentPosition='left'
            cachePolicy='memory-disk'
          />
        ) : (
          <Text
            variant={isCompact ? "title" : "display"}
            weight='bold'
            numberOfLines={2}
            style={{ color: "#FFFFFF", marginBottom: 6 }}
          >
            {slide.title}
          </Text>
        )}

        {slide.subtitle ? (
          <Text
            variant='caption'
            numberOfLines={1}
            style={{ color: rgba("#FFFFFF", 0.92), marginBottom: 4 }}
          >
            {slide.subtitle}
          </Text>
        ) : null}

        {badges ? (
          <Text
            variant='caption'
            numberOfLines={1}
            style={{ color: rgba("#FFFFFF", 0.72), marginBottom: 8 }}
          >
            {badges}
          </Text>
        ) : null}

        {slide.overview ? (
          // Two lines at every width. One line was the plan, but react-native-
          // web implements a single-line clamp as `white-space: nowrap` +
          // `text-overflow: ellipsis` rather than a line clamp, so the text
          // genuinely overflows its box — which the sweep reports as an
          // overflowing element, and which is a real horizontal-scroll hazard
          // rather than a false positive. Two lines clamp properly, and a
          // 429 px hero has the room.
          <Text
            variant='body'
            numberOfLines={2}
            style={{ color: rgba("#FFFFFF", 0.85), marginBottom: 12 }}
          >
            {slide.overview}
          </Text>
        ) : null}

        {isResuming ? (
          <View
            accessibilityRole='progressbar'
            accessibilityValue={{
              now: Math.round((slide.progress ?? 0) * 100),
              min: 0,
              max: 100,
            }}
            style={{
              width: Math.min(contentWidth, 220),
              height: 4,
              borderRadius: radius.pill,
              backgroundColor: rgba("#FFFFFF", 0.28),
              overflow: "hidden",
              marginBottom: 12,
            }}
          >
            <View
              style={{
                width: `${Math.round(Math.min(slide.progress ?? 0, 1) * 100)}%`,
                height: "100%",
                borderRadius: radius.pill,
                backgroundColor: accent[500],
              }}
            />
          </View>
        ) : null}

        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button
            testID='home-hero-play'
            variant='primary'
            size={isCompact ? "sm" : "md"}
            icon='play'
            onPress={onPressPlay}
          >
            {isResuming ? t("home.hero.resume") : t("common.play")}
          </Button>
          <Button
            testID='home-hero-info'
            variant='secondary'
            size={isCompact ? "sm" : "md"}
            icon='info'
            onPress={onPressInfo}
          >
            {t("home.hero.more_info")}
          </Button>
        </View>
      </View>
    </View>
  );
};
