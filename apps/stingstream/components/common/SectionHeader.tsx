import { Pressable, View } from "react-native";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { Icon } from "./Icon";
import { Text } from "./Text";

type Props = {
  title: string;
  /** Usually "See all". Renders only when `onPressAction` is given too. */
  actionLabel?: string;
  actionDisabled?: boolean;
  onPressAction?: () => void;
  /** Drawn between the title and the action — a count pill, a small control. */
  accessory?: React.ReactNode;
};

/**
 * The title above a row or a block of settings.
 *
 * One `heading` on the left, an optional accent-coloured action on the right,
 * and the page gutter either side so a row's title lines up with the first card
 * under it at every width.
 */
export const SectionHeader: React.FC<Props> = ({
  title,
  actionLabel,
  actionDisabled = false,
  onPressAction,
  accessory,
}) => {
  const { gutter } = useBreakpoint();
  const shouldShowAction = Boolean(actionLabel) && Boolean(onPressAction);

  return (
    <View
      style={{
        paddingHorizontal: gutter,
        marginBottom: 8,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Text variant='heading' weight='semibold' style={{ flexShrink: 1 }}>
        {title}
      </Text>
      {accessory}
      {shouldShowAction && (
        <Pressable
          onPress={onPressAction}
          disabled={actionDisabled}
          accessibilityRole='button'
          accessibilityLabel={actionLabel}
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 4,
            paddingLeft: 12,
            opacity: actionDisabled ? 0.4 : 1,
          }}
        >
          <Text
            variant='caption'
            weight='semibold'
            tone={actionDisabled ? "disabled" : "accent"}
          >
            {actionLabel}
          </Text>
          <Icon
            name='chevronRight'
            size={14}
            tone={actionDisabled ? "disabled" : "accent"}
            style={{ marginLeft: 2 }}
          />
        </Pressable>
      )}
    </View>
  );
};
