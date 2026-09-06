import { type StyleProp, View, type ViewStyle } from "react-native";
import { Icon } from "./Icon";
import { Text } from "./Text";

export interface FormErrorProps {
  /** Nothing renders when this is empty, so a caller can pass state directly. */
  message?: string | null;
  style?: StyleProp<ViewStyle>;
}

/**
 * The inline "that did not work" line under a field or a form.
 *
 * **`Alert.alert` renders nothing at all on react-native-web** — not a fallback,
 * not a warning, nothing. That is why a wrong password on the web build gave no
 * feedback whatsoever (bug 2 in the v0.2.0 plan): five call sites in the login
 * screen reported failures through `Alert.alert`, and the browser dropped every
 * one of them. Anything a user can reach in a browser reports its errors
 * through this component instead. `components/stingstream/shared/confirm.ts`
 * is the same lesson for destructive confirmations.
 *
 * It announces itself to a screen reader, because an error that only exists
 * visually is the same bug with a smaller audience.
 */
export const FormError: React.FC<FormErrorProps> = ({ message, style }) => {
  if (!message) return null;

  return (
    <View
      accessibilityRole='alert'
      accessibilityLiveRegion='polite'
      style={[
        {
          flexDirection: "row",
          alignItems: "flex-start",
          marginTop: 6,
        },
        style,
      ]}
    >
      <Icon name='error' tone='danger' size={16} style={{ marginTop: 1 }} />
      <Text
        variant='caption'
        tone='danger'
        style={{ flex: 1, marginLeft: 6 }}
        selectable
      >
        {message}
      </Text>
    </View>
  );
};
