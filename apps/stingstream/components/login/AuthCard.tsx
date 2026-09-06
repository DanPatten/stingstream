import type { PropsWithChildren } from "react";
import { Platform, ScrollView, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { StingStreamWordmark } from "@/components/brand";
import { elevation, radius, tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";

/** The card never grows past this, at any window width. */
const MAX_WIDTH = 420;

/**
 * The one surface every pre-session screen sits on: connecting, first run, sign in, address form.
 *
 * A single card, centred on an otherwise empty page. Deliberately not a backdrop-image hero — the
 * app has no library to draw from before you are signed in, and a stock photograph behind a login
 * form is the thing that makes a self-hosted app look like a template. What the page does say is
 * whose it is: the wordmark sits on top of the card and is the first thing that renders, which is
 * the direct answer to "it doesn't say StingStream anywhere".
 */
export const AuthCard: React.FC<PropsWithChildren> = ({ children }) => {
  const { isWebWide, gutter } = useBreakpoint();
  const { accent } = useTheme();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: tokens.color.bg["0"],
      }}
    >
      {isWebWide ? <AccentGlow color={accent[500]} /> : null}
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: gutter,
          paddingVertical: 32,
        }}
        keyboardShouldPersistTaps='handled'
      >
        <View style={{ width: "100%", maxWidth: MAX_WIDTH }}>
          <View style={{ alignItems: "center", marginBottom: 24 }}>
            <StingStreamWordmark height={isWebWide ? 34 : 30} />
          </View>
          <View
            style={[
              {
                backgroundColor: tokens.color.bg["1"],
                borderRadius: radius.lg,
                borderWidth: 1,
                borderColor: tokens.color.border.subtle,
                padding: isWebWide ? 28 : 20,
              },
              elevation(2),
            ]}
          >
            {children}
          </View>
        </View>
      </ScrollView>
    </View>
  );
};

/**
 * A very faint accent wash behind the card, wide web only.
 *
 * An SVG radial gradient rather than stacked circles: react-native-web has no blur that survives
 * into a static export, and a hard-edged translucent circle reads as a visible ring rather than as
 * light. `pointerEvents="none"` so it can never swallow a click meant for the card.
 */
const AccentGlow: React.FC<{ color: string }> = ({ color }) => (
  <View
    pointerEvents='none'
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      // Safari has been known to paint an SVG gradient over sibling content when the stacking
      // context is implicit; an explicit zIndex keeps the card above it everywhere.
      zIndex: 0,
      ...(Platform.OS === "web" ? ({ userSelect: "none" } as object) : null),
    }}
  >
    <Svg width='100%' height='100%'>
      <Defs>
        <RadialGradient id='authGlow' cx='50%' cy='38%' r='62%'>
          <Stop offset='0' stopColor={color} stopOpacity={0.14} />
          <Stop offset='0.55' stopColor={color} stopOpacity={0.04} />
          <Stop offset='1' stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x='0' y='0' width='100%' height='100%' fill='url(#authGlow)' />
    </Svg>
  </View>
);
