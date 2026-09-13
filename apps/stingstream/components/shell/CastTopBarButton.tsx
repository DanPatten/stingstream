import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, type ViewStyle } from "react-native";
import {
  CastContext,
  CastState,
  useCastState,
  useMediaStatus,
} from "react-native-google-cast";
import { HeaderIcon } from "@/components/common/HeaderIcon";
import { radius, webFocusRing } from "@/constants/theme";
import { useFocusVisible } from "@/hooks/useFocusVisible";
import { useTheme } from "@/hooks/useTheme";

/**
 * The top bar's cast control, in the far right corner of every desktop screen.
 *
 * Drawn exactly like Watch together beside it, and always drawn, whatever the
 * browser. Nothing here guesses whether casting will work: a Firefox extension
 * can provide the same API Chrome does, and the only reliable answer is the one
 * the Cast sender gives when it is asked. Where it says no, pressing opens a
 * dialog that says why (`components/cast/CastControlsSheet.tsx`).
 *
 * The glyph is the Cast mark from Material Symbols rather than the Ionicons set
 * the rest of the bar uses: people look for that exact shape, and Ionicons has
 * nothing like it.
 */
export const CastTopBarButton: React.FC = () => {
  const { t } = useTranslation();
  const { accent, color } = useTheme();
  const castState = useCastState();
  const mediaStatus = useMediaStatus();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);
  const connected = castState === CastState.CONNECTED;

  return (
    <Pressable
      testID='shell-cast'
      accessibilityRole='button'
      accessibilityLabel={t("shell.cast_to_device")}
      onPress={() => {
        // Something playing: the controls. Otherwise the picker, which is also where a connected
        // session with nothing loaded is ended.
        if (mediaStatus?.currentItemId != null) {
          void CastContext.showExpandedControls();
        } else {
          void CastContext.showCastDialog();
        }
      }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          width: 36,
          height: 36,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.sm,
          backgroundColor: hovered ? color.bg["3"] : "transparent",
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, color) }
            : null),
        } as ViewStyle
      }
    >
      <HeaderIcon
        name='cast'
        size={20}
        tintColor={connected ? accent[500] : color.text.secondary}
      />
    </Pressable>
  );
};

export default CastTopBarButton;
