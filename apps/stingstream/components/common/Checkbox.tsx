import { View } from "react-native";
import { radius, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { Icon } from "./Icon";

/**
 * A box you tick, for a question whose answer is *several of these*.
 *
 * **Not a radio, and the difference is the whole point.** A ring says "one of these" — it is the
 * shape browsers, phones and every settings screen use for a choice that excludes its neighbours.
 * The library picker drew rings over a list where every row is independent, and Dan asked the
 * obvious question: *"why is this a radio instead of a checkbox"*. Nothing about the behaviour was
 * wrong; the control was telling the reader the opposite of what it did.
 *
 * Presentational only — no press handling, because the row it sits in is already the target.
 * `Switch` is its sibling for a single on/off setting; this is for one row of a set.
 *
 * The accent is read rather than named: a hard-coded teal is wrong for anybody who chose violet or
 * amber in Appearance.
 */
export const Checkbox: React.FC<{
  checked: boolean;
  disabled?: boolean;
  /** The box's edge. The tick is sized from it. */
  size?: number;
}> = ({ checked, disabled = false, size = 20 }) => {
  const { color, accent } = useTheme();

  return (
    <View
      // Decorative: the row that owns the press carries the accessible name and the checked state,
      // so a screen reader must not meet this as a second control.
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      style={{
        width: size,
        height: size,
        borderRadius: radius.xs,
        borderWidth: 2,
        borderColor: checked ? accent[500] : color.border.strong,
        backgroundColor: checked ? accent[500] : "transparent",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? tokens.control.disabledOpacity : 1,
      }}
    >
      {checked ? (
        <Icon name='check' size={size - 6} color={accent.onAccent} />
      ) : null}
    </View>
  );
};
