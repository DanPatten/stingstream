import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { Icon, type IconName } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, rgba, tokens } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";

/**
 * One decision, as an icon, with the words on hover.
 *
 * Dan, on a row that had a full-width teal *Approve* and a *Decline* beside it: *"approve/decline
 * should just be inline icons with hover text"*. Two labelled buttons for a two-word decision took
 * a whole line of the page and still had to be read; a tick and a cross beside the row they belong
 * to do not.
 *
 * **The tooltip is drawn rather than a DOM `title`.** react-native-web has no prop that maps to
 * one — `accessibilityLabel` becomes `aria-label`, which a screen reader announces and a pointer
 * never shows. `RailTooltip` in the sidebar made the same choice for the same reason; this is the
 * inline version of it, and it uses the app's own type and surfaces.
 *
 * **Hover is web-only, and the label is not.** A phone has no pointer, so the tooltip never
 * appears there and `accessibilityLabel` is the whole of what a non-visual user gets — which is
 * why the label is required rather than optional.
 */
export const IconAction: React.FC<{
  icon: IconName;
  /** What it does, shown on hover and read out by a screen reader. */
  label: string;
  tone?: "default" | "success" | "danger";
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  onPress: () => void;
}> = ({
  icon,
  label,
  tone = "default",
  disabled = false,
  busy = false,
  testID,
  onPress,
}) => {
  const { color } = useTheme();
  const states = usePressableStates({ disabled: disabled || busy });

  const accent =
    tone === "success"
      ? color.state.success
      : tone === "danger"
        ? color.state.danger
        : color.text.primary;

  const lit = states.hovered || states.pressed;

  return (
    <View>
      <Pressable
        testID={testID}
        accessibilityRole='button'
        accessibilityLabel={label}
        accessibilityState={{ disabled: disabled || busy }}
        disabled={disabled || busy}
        onPress={onPress}
        hitSlop={6}
        {...states.handlers}
        style={[
          {
            width: tokens.control.minTouchTarget,
            height: tokens.control.minTouchTarget,
            borderRadius: tokens.control.minTouchTarget / 2,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: states.pressed
              ? rgba(accent, 0.24)
              : states.hovered
                ? rgba(accent, 0.14)
                : "transparent",
            opacity: disabled || busy ? tokens.control.disabledOpacity : 1,
          },
          states.webStyle,
        ]}
      >
        {busy ? (
          <ActivityIndicator size='small' />
        ) : (
          <Icon
            name={icon}
            size={18}
            color={lit ? accent : color.text.tertiary}
          />
        )}
      </Pressable>

      {Platform.OS === "web" && states.hovered && !busy ? (
        <View
          // **Beside the icon, not above it.** `ListGroup` rounds its corners with
          // `overflow: hidden`, so anything drawn outside a row is clipped — a tooltip above the
          // button rendered as a sliver of a box. To the left it stays inside the row's own height
          // and inside the card, and there is nothing but empty row there to cover.
          //
          // Decorative: the button beside it already carries the same string as its accessible
          // name, so a screen reader must not meet it twice.
          pointerEvents='none'
          style={{
            position: "absolute",
            right: tokens.control.minTouchTarget + 4,
            top: 0,
            bottom: 0,
            justifyContent: "center",
            zIndex: 20,
          }}
        >
          <View
            style={{
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: color.border.subtle,
              backgroundColor: color.bg["3"],
            }}
          >
            <Text variant='caption' numberOfLines={1}>
              {label}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
};
