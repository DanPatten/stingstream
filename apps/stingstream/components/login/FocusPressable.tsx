import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { usePressableStates } from "@/hooks/usePressableStates";

/**
 * A plain text/icon control on a pre-session card — the password reveal toggle, "Advanced",
 * "Use a different server" — that is not a `Button` or an `Input` and so gets none of their
 * built-in interaction states for free. `usePressableStates` is what draws the keyboard focus
 * ring everywhere else in the app; this is the one wrapper every such control on these cards was
 * missing (critique: "the reveal-eye button has no visible focus ring", F-32).
 */
export const FocusPressable: React.FC<
  Omit<PressableProps, "style"> & { style?: StyleProp<ViewStyle> }
> = ({ style, children, ...props }) => {
  const states = usePressableStates();
  return (
    <Pressable {...props} {...states.handlers} style={[style, states.webStyle]}>
      {children}
    </Pressable>
  );
};
