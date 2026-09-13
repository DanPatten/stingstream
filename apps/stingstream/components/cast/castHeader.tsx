import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type ColorValue, Platform } from "react-native";
import { HeaderButtonGroup } from "@/components/common/HeaderButton";
import { headerTarget } from "@/components/shell/headerTarget";

// Required behind the TV check rather than imported: a TV build links no cast SDK at all
// (`app.config.ts` skips the plugin under EXPO_TV=1).
const Chromecast = Platform.isTV ? null : require("@/components/Chromecast");

/**
 * The cast button as a stack header draws it, on a phone and in a narrow browser.
 *
 * It sits on every header, not just the ones showing something playable. Google's
 * sender guidance asks for exactly that: connecting is a thing you do before you
 * pick a title, so the control has to be wherever you are when you think of it.
 * On web wide there are no stack headers and the top bar carries it instead
 * (`components/shell/CastTopBarButton.tsx`).
 */
export const CastHeaderButton: React.FC = () => {
  const { t } = useTranslation();
  if (!Chromecast) return null;
  return (
    <Chromecast.Chromecast
      accessibilityLabel={t("shell.cast_to_device")}
      style={headerTarget}
    />
  );
};

type HeaderRight = (props: {
  tintColor?: ColorValue;
  canGoBack?: boolean;
}) => ReactNode;

/**
 * A screen's own `headerRight` with the cast button after it.
 *
 * `useStackScreenOptions` puts the cast button on every header by default, and a
 * screen that sets `headerRight` replaces that default wholesale. Wrapping the
 * screen's actions in this keeps the cast button in the corner. Pass a render
 * function that returns bare buttons, not its own `HeaderButtonGroup`: groups do
 * not nest cleanly (see `HeaderButtonGroup`).
 */
export function withCastAction(headerRight?: HeaderRight): HeaderRight {
  if (Platform.isTV) return headerRight ?? (() => null);
  return (props) => (
    // A lone button gets no end padding from the group, which on a phone is
    // right (the platform insets the bar item) and in a browser puts the glyph
    // hard against the window edge. Same 8 px either way there, so the corner
    // control does not shift between a screen with one action and one with two.
    <HeaderButtonGroup
      style={Platform.OS === "web" ? { paddingRight: 8 } : undefined}
    >
      {headerRight?.(props)}
      <CastHeaderButton />
    </HeaderButtonGroup>
  );
}
