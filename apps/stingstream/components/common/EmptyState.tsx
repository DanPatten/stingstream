import { type StyleProp, View, type ViewStyle } from "react-native";
import { Button } from "@/components/Button";
import { rgba, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

export interface EmptyStateProps {
  title: string;
  /** One line of why, or what to do about it. */
  detail?: string;
  /** Defaults to nothing: a glyph that means nothing is worse than none. */
  icon?: IconName;
  action?: {
    label: string;
    onPress: () => void;
    icon?: IconName;
  };
  style?: StyleProp<ViewStyle>;
}

/**
 * "There is nothing here."
 *
 * Deliberately distinct from `GapNotice` (a feature the server does not expose
 * yet) and from `ErrorState` (something failed): an empty library, a failed
 * request and a missing endpoint are three different messages, and a screen
 * that renders the same box for all three sends somebody hunting a bug that is
 * not there.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  detail,
  icon,
  action,
  style,
}) => {
  const { accent } = useTheme();

  return (
    <View
      style={[
        {
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: 64,
          paddingHorizontal: 24,
        },
        style,
      ]}
    >
      {icon ? (
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 28,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: rgba(accent[500], 0.12),
            marginBottom: 16,
          }}
        >
          <Icon name={icon} size={26} tone='accent' />
        </View>
      ) : null}
      <Text variant='heading' weight='semibold' align='center'>
        {title}
      </Text>
      {detail ? (
        <Text
          variant='caption'
          tone='secondary'
          align='center'
          style={{ marginTop: 6, maxWidth: tokens.maxWidth.prose }}
        >
          {detail}
        </Text>
      ) : null}
      {action ? (
        <Button
          variant='secondary'
          size='sm'
          icon={action.icon}
          onPress={action.onPress}
          style={{ marginTop: 16 }}
        >
          {action.label}
        </Button>
      ) : null}
    </View>
  );
};
