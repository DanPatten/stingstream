import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Dialog } from "@/components/common/Dialog";
import { Icon, type IconName } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";

export interface MoreMenuAction {
  key: string;
  icon: IconName;
  label: string;
  /** A second line under the label, when the label alone is not enough. */
  description?: string;
  /** Makes the whole row the control. */
  onPress?: () => void;
  /**
   * An existing control that owns this action — the download button, the
   * media-options button. The row draws the name; the control does the work,
   * which is what keeps a component this menu does not own out of it.
   */
  trailing?: ReactNode;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  actions: MoreMenuAction[];
  title?: string;
}

/**
 * Everything the details page can do that is not Play.
 *
 * A card on a desktop browser and a bottom sheet everywhere else, because
 * `Dialog` already is — a panel sliding up from the bottom of a 27-inch monitor
 * is most of what "clunky" meant. The alternative was a row of eight unlabelled
 * icons across the top of the page (pass-02 F-24, "five unnamed icon buttons");
 * a menu can afford words.
 */
export const MoreMenu: React.FC<Props> = ({
  visible,
  onClose,
  actions,
  title,
}) => (
  <Dialog visible={visible} onClose={onClose} title={title}>
    <View style={{ marginHorizontal: -8 }}>
      {actions.map((action) => (
        <MoreMenuRow key={action.key} action={action} onClose={onClose} />
      ))}
    </View>
  </Dialog>
);

const MoreMenuRow: React.FC<{
  action: MoreMenuAction;
  onClose: () => void;
}> = ({ action, onClose }) => {
  const states = usePressableStates({});
  const interactive = Boolean(action.onPress);

  const body = (
    <>
      <Icon name={action.icon} size={20} tone='secondary' />
      <View style={{ flex: 1, marginLeft: 14 }}>
        <Text variant='body'>{action.label}</Text>
        {action.description ? (
          <Text variant='caption' tone='tertiary' style={{ marginTop: 2 }}>
            {action.description}
          </Text>
        ) : null}
      </View>
      {action.trailing}
      {interactive ? (
        <Icon name='chevronRight' size={16} tone='tertiary' />
      ) : null}
    </>
  );

  const box = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    minHeight: tokens.control.minTouchTarget,
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderRadius: radius.sm,
  };

  if (!interactive) {
    return <View style={box}>{body}</View>;
  }

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={action.label}
      onPress={() => {
        onClose();
        action.onPress?.();
      }}
      {...states.handlers}
      style={[
        box,
        { backgroundColor: states.overlay ?? "transparent" },
        states.webStyle,
      ]}
    >
      {body}
    </Pressable>
  );
};
