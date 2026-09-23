import type { ReactNode, RefObject } from "react";
import { Platform, type View } from "react-native";
import type { IconName } from "@/components/common/Icon";
import { AnchoredMenu, MenuItem } from "@/components/common/Menu";
import { MENU_SHEET_HANDOFF_MS } from "@/constants/animation";

export interface MoreMenuAction {
  key: string;
  icon: IconName;
  label: string;
  /** A short value at the end of the row: the current choice, a profile name. */
  description?: string;
  /** Makes the whole row the control. */
  onPress?: () => void;
  /**
   * An existing control that owns this action and shows a state of its own: the download
   * button, with its progress. The row draws the name; the control does the work. A control
   * that only repeats the row's icon belongs behind `onPress` instead: the versions and
   * remote-session badges were exactly that, and read as stray buttons (Dan, 2026-09-22).
   */
  trailing?: ReactNode;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  actions: MoreMenuAction[];
  /** The "..." it opens from. */
  anchorRef: RefObject<View | null>;
  title?: string;
}

/**
 * Everything the details page can do that is not Play.
 *
 * A dropdown under the "..." in a browser and a bottom sheet on a device, because `AnchoredMenu`
 * already is. It was a centred card, which Dan replaced with the menu Plex uses (2026-09-14). The
 * alternative was a row of eight unlabelled icons across the top of the page (pass-02 F-24, "five
 * unnamed icon buttons"); a menu can afford words.
 */
export const MoreMenu: React.FC<Props> = ({
  visible,
  onClose,
  actions,
  anchorRef,
  title,
}) => (
  <AnchoredMenu
    visible={visible}
    onClose={onClose}
    anchorRef={anchorRef}
    title={title}
    minWidth={240}
    maxWidth={360}
  >
    {actions.map((action) => (
      <MenuItem
        key={action.key}
        icon={action.icon}
        label={action.label}
        description={action.description}
        trailing={action.trailing}
        onPress={
          action.onPress
            ? () => {
                onClose();
                if (Platform.OS === "web") action.onPress?.();
                else
                  setTimeout(() => action.onPress?.(), MENU_SHEET_HANDOFF_MS);
              }
            : undefined
        }
      />
    ))}
  </AnchoredMenu>
);
