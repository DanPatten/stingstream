import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  View,
} from "react-native";
import { rgba } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";

/** How much of the bar the fade covers at either end. */
const FADE_WIDTH = 28;
/** Ignore a pixel or two of rounding when deciding whether an end is reached. */
const SCROLL_EPSILON = 2;

interface Props {
  /** Opaque, and the same color as the page behind it. See the note in the library bar. */
  background: string;
  testID?: string;
}

/**
 * A row of filter chips that scrolls sideways, with a fade at whichever end
 * still has chips beyond it.
 *
 * Shared by every screen that has a filter bar, rather than copied into each.
 * It started life inside `LibraryFilterBar` and moved out when Requests grew a
 * bar of its own: eighty lines of scroll geometry duplicated between two bars
 * is two bars that answer a swipe differently the first time one of them is
 * touched.
 *
 * The fade is the affordance. The row used to run straight off the viewport
 * with nothing on screen to suggest swiping, so "Sort by" was simply invisible
 * on a phone.
 */
export const ScrollingFilterBar: React.FC<React.PropsWithChildren<Props>> = ({
  background,
  testID,
  children,
}) => {
  const { gutter } = useBreakpoint();
  const [offset, setOffset] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) =>
      setOffset(event.nativeEvent.contentOffset.x),
    [],
  );
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) =>
      setViewportWidth(event.nativeEvent.layout.width),
    [],
  );
  const handleContentSizeChange = useCallback(
    (width: number) => setContentWidth(width),
    [],
  );

  const fadeLeft = offset > SCROLL_EPSILON;
  const fadeRight = offset + viewportWidth < contentWidth - SCROLL_EPSILON;

  return (
    <View
      testID={testID}
      style={{ backgroundColor: background, position: "relative" }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onLayout={handleLayout}
        onContentSizeChange={handleContentSizeChange}
        contentContainerStyle={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: gutter,
          paddingVertical: 12,
        }}
      >
        {children}
      </ScrollView>

      {fadeLeft && <EdgeFade side='left' color={background} />}
      {fadeRight && <EdgeFade side='right' color={background} />}
    </View>
  );
};

/** A chip half-under a fade is the affordance: there is more this way. */
const EdgeFade: React.FC<{ side: "left" | "right"; color: string }> = ({
  side,
  color,
}) => (
  <LinearGradient
    pointerEvents='none'
    // Two stops of the same color, opaque to clear: fading to `transparent`
    // goes through transparent *black* on some engines and leaves a grey
    // smear over the chips.
    colors={side === "left" ? [color, rgba(color, 0)] : [rgba(color, 0), color]}
    start={{ x: 0, y: 0.5 }}
    end={{ x: 1, y: 0.5 }}
    style={{
      position: "absolute",
      top: 0,
      bottom: 0,
      width: FADE_WIDTH,
      ...(side === "left" ? { left: 0 } : { right: 0 }),
    }}
  />
);
