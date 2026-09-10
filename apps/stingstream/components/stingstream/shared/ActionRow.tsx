import type { ReactNode } from "react";
import {
  Platform,
  Pressable,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";

/**
 * A row whose label opens one thing and whose icons do another.
 *
 * **Not `ListItem`.** A pressable `ListItem` renders a real `<button>` on the web, and the row
 * action is a button too — nesting them is invalid HTML, which React says out loud (*"<button>
 * cannot contain a nested <button>"*, seen live on this screen at 1440) and which flattens the
 * whole row into one control for a screen reader. So the label and the action are **siblings**: one
 * `Pressable` holding the avatar and the text, the button beside it.
 *
 * The metrics are `ListItem`'s, deliberately — the 44 px floor, the 16 px gutter, the same hover
 * and pressed tints — because this sits in a `ListGroup` next to rows that are `ListItem`s and a
 * row that is nearly the same is worse than one that is either identical or clearly different.
 * `style` is accepted and applied because `ListGroup` clones the hairline separator onto it.
 *
 * Lifted out of the Users screen when Servers grew rows of the same shape — a server you can
 * open beside icons that do something to it. Two copies of a rule this fiddly is one copy too
 * many.
 */
export const ActionRow: React.FC<{
  testID: string;
  title: string;
  subtitle: string;
  leading: ReactNode;
  actions: ReactNode;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}> = ({ testID, title, subtitle, leading, actions, onPress, style }) => {
  const states = usePressableStates();

  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          minHeight: 44,
          paddingVertical: Platform.OS === "android" ? 6 : 8,
          paddingHorizontal: 16,
          backgroundColor: states.pressed
            ? tokens.color.bg["3"]
            : states.hovered
              ? tokens.color.bg["2"]
              : tokens.color.bg["1"],
        },
        style,
      ]}
    >
      <Pressable
        accessibilityRole='button'
        onPress={onPress}
        {...states.handlers}
        style={[
          {
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            minHeight: tokens.control.minTouchTarget,
            borderRadius: radius.sm,
          },
          states.webStyle,
        ]}
      >
        {leading}
        <View style={{ flexShrink: 1, marginLeft: 12 }}>
          <Text numberOfLines={1}>{title}</Text>
          <Text
            variant='caption'
            tone='secondary'
            numberOfLines={2}
            style={{ marginTop: 2 }}
          >
            {subtitle}
          </Text>
        </View>
      </Pressable>
      <View
        style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}
      >
        {actions}
      </View>
    </View>
  );
};
