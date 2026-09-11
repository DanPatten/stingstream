import { useSegments } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AccessibilityInfo,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  View,
  type ViewStyle,
} from "react-native";
import Carousel, {
  type ICarouselInstance,
} from "react-native-reanimated-carousel";
import { Icon } from "@/components/common/Icon";
import { Skeleton } from "@/components/common/Skeleton";
import { getItemNavigation } from "@/components/common/TouchableItemRouter";
import { type BreakpointName, motion, radius, rgba } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import {
  type HeroSlide as HeroSlideData,
  useHeroItems,
} from "@/hooks/useHeroItems";
import { usePressableStates } from "@/hooks/usePressableStates";
import { HeroDots } from "./HeroDots";
import { HeroSlide } from "./HeroSlide";

const isWeb = Platform.OS === "web";

/** How long a slide holds before the hero moves on by itself. */
const AUTO_ADVANCE_MS = 8000;

/**
 * How tall the hero is at a given rendered width.
 *
 * Three different shapes rather than one aspect ratio: a phone can afford a
 * near-square panel because the copy is stacked under a portrait-ish crop,
 * while a 1440 px browser given the same ratio would be a 1584 px tall wall of
 * picture with the first row of content somewhere below the fold. The
 * expanded cap stops a 2560 px monitor from doing the same thing.
 *
 * Exported because it is the one number `Home` needs to reserve the space
 * before the slides have arrived.
 */
export const heroHeight = (
  width: number,
  breakpoint: BreakpointName,
): number => {
  if (breakpoint === "compact") return Math.round(Math.min(width * 1.1, 440));
  if (breakpoint === "medium") return Math.round(width * 0.5);
  return Math.round(Math.min(width * 0.42, 640));
};

/** Never ask the server for more backdrop than twice what is drawn. */
const backdropRequestWidth = (width: number) =>
  Math.min(Math.max(Math.round(width * 2), 640), 1920);

/**
 * Whether the platform has been asked to keep still.
 *
 * Not only an accessibility setting: the screenshot sweep runs its browser
 * contexts with reduced motion precisely so a hero that advances on a timer
 * cannot make two runs of the same screen differ.
 */
const useReduceMotion = (): boolean => {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(enabled);
      })
      .catch(() => {
        /* Not every platform implements it; moving is the safe miss. */
      });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  return reduceMotion;
};

/**
 * The spotlight at the top of the home screen: one thing to watch, big, with
 * a way to start it.
 *
 * This is the React Native hero — it runs on web and on Android, where there
 * was previously nothing at all above the rows (pass-02 F-33: "phone layout at
 * 1440 … no hero"). iOS keeps the native SwiftUI carousel; `HomeHeroCarousel`
 * is the switch between the two, and `useHeroItems` feeds both, so the two
 * platforms can never disagree about what is worth showing.
 *
 * Paging follows the input the platform actually has: a swipe on touch, arrows
 * on hover and dots everywhere. The 8-second auto-advance stops while the
 * pointer is over the hero or focus is inside it — a carousel that slides out
 * from under a cursor reading its synopsis is the single most complained-about
 * thing a carousel does — and never starts at all under reduced motion.
 */
export const HeroSpotlight: React.FC = () => {
  const { t } = useTranslation();
  const {
    name: breakpoint,
    width: windowWidth,
    gutter,
    isWebWide,
  } = useBreakpoint();
  const router = useRouter();
  const segments = useSegments();
  const from = (segments as string[])[2] || "(home)";
  const reduceMotion = useReduceMotion();

  // The hero is full-bleed inside whatever column it lands in, which on web
  // wide is the window minus the sidebar — so it is measured rather than
  // derived from the window. The window width is the estimate used for the
  // very first frame, before layout has happened.
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const width = measuredWidth || windowWidth;
  const height = heroHeight(width, breakpoint);

  const { slides, isLoading, isEnabled, hasActiveFilters } = useHeroItems({
    backdropWidth: backdropRequestWidth(width),
  });

  const carouselRef = useRef<ICarouselInstance>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusWithin, setIsFocusWithin] = useState(false);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0) setMeasuredWidth(next);
  }, []);

  const goTo = useCallback((index: number) => {
    carouselRef.current?.scrollTo({ index, animated: true });
  }, []);

  const step = useCallback((direction: 1 | -1) => {
    carouselRef.current?.scrollTo({ count: direction, animated: true });
  }, []);

  const openItem = useCallback(
    (slide: HeroSlideData, autoPlay: boolean) => {
      const navigation = getItemNavigation(slide.item, from) as {
        pathname: string;
        params?: Record<string, unknown>;
      };
      // Both buttons land on the pre-play page: it is where the resume
      // position, version, audio and subtitle choices live, and starting
      // playback straight from the hero would skip every one of them. Play
      // carries `autoPlay`, which is what makes the label honest.
      router.push(
        (autoPlay
          ? {
              ...navigation,
              params: { ...(navigation.params ?? {}), autoPlay: "true" },
            }
          : navigation) as never,
      );
    },
    [from, router],
  );

  if (!isEnabled) return null;

  if (isLoading) {
    return (
      <View testID='home-hero' onLayout={handleLayout}>
        <Skeleton width='100%' height={height} radius={0} />
      </View>
    );
  }

  // Nothing to spotlight and no filter to blame: an empty library is not a
  // broken hero, and a black panel above the rows says nothing. A filter that
  // emptied it keeps the space, so the way back is still on screen.
  if (slides.length === 0 && !hasActiveFilters) return null;
  if (slides.length === 0) {
    return (
      <View testID='home-hero' onLayout={handleLayout}>
        <Skeleton width='100%' height={height} radius={0} />
      </View>
    );
  }

  const canPage = slides.length > 1;
  const autoPlay = canPage && !reduceMotion && !isHovered && !isFocusWithin;
  const showArrows = isWeb && canPage;

  return (
    <Pressable
      testID='home-hero'
      // Not a control: the hover and focus handlers are the pause, and the
      // real controls are the buttons inside each slide.
      accessible={false}
      onHoverIn={() => setIsHovered(true)}
      onHoverOut={() => setIsHovered(false)}
      onFocus={() => setIsFocusWithin(true)}
      onBlur={() => setIsFocusWithin(false)}
      onLayout={handleLayout}
      style={{ width: "100%", height }}
    >
      <Carousel
        ref={carouselRef}
        data={slides}
        width={width}
        height={height}
        loop={canPage}
        enabled={canPage}
        autoPlay={autoPlay}
        autoPlayInterval={AUTO_ADVANCE_MS}
        scrollAnimationDuration={motion.crossfade}
        onSnapToItem={setActiveIndex}
        renderItem={({ item, index }) => (
          <HeroSlide
            slide={item}
            width={width}
            height={height}
            breakpoint={breakpoint}
            gutter={gutter}
            isActive={index === activeIndex}
            onPressPlay={() => openItem(item, true)}
            onPressInfo={() => openItem(item, false)}
          />
        )}
      />

      {showArrows ? (
        <>
          <HeroArrow
            direction='left'
            visible={isHovered}
            inset={gutter}
            label={t("home.hero.previous")}
            onPress={() => step(-1)}
          />
          <HeroArrow
            direction='right'
            visible={isHovered}
            inset={gutter}
            label={t("home.hero.next")}
            onPress={() => step(1)}
          />
        </>
      ) : null}

      <HeroDots
        count={slides.length}
        activeIndex={activeIndex}
        onPressIndex={goTo}
        interactive={isWebWide}
        style={{
          position: "absolute",
          right: gutter,
          bottom: breakpoint === "compact" ? 12 : 20,
        }}
      />
    </Pressable>
  );
};

/** One end of the hero: a translucent disc that appears on hover. */
const HeroArrow: React.FC<{
  direction: "left" | "right";
  visible: boolean;
  inset: number;
  label: string;
  onPress: () => void;
}> = ({ direction, visible, inset, label, onPress }) => {
  const states = usePressableStates();

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      onPress={onPress}
      {...states.handlers}
      // Reachable by keyboard whether or not the pointer is over the hero: the
      // fade is a pointer affordance, not a permission. Focus reveals it too,
      // because a ring on something at zero opacity shows nothing.
      style={
        [
          {
            position: "absolute",
            top: 0,
            bottom: 0,
            width: 44,
            alignItems: "center",
            justifyContent: "center",
            opacity: visible || states.focused ? 1 : 0,
            ...(direction === "left"
              ? { left: inset / 2 }
              : { right: inset / 2 }),
          },
          { transitionDuration: `${motion.fast}ms` },
          // The disc below carries the ring, so this must not draw the
          // browser's own on top of it.
          isWeb ? { outlineStyle: "none" } : null,
        ] as ViewStyle[]
      }
    >
      {/* The ring goes on the disc rather than on the press target, which is a
          44px column the full height of the hero: a ring around that is a
          stripe down the artwork, and the hero clips it at the top anyway. */}
      <View
        style={
          {
            width: 40,
            height: 40,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: rgba("#000000", 0.55),
            ...states.webStyle,
          } as ViewStyle
        }
      >
        <Icon
          name={direction === "left" ? "chevronLeft" : "chevronRight"}
          size={20}
          color='#FFFFFF'
        />
      </View>
    </Pressable>
  );
};
