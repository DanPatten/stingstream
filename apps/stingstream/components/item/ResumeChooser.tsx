import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Dialog } from "@/components/common/Dialog";
import { MenuItem } from "@/components/common/Menu";
import { formatResumePosition } from "@/utils/resume";

interface Props {
  visible: boolean;
  /** The title being played, as the card's heading. */
  title?: string;
  positionTicks: number;
  onResume: () => void;
  onRestart: () => void;
  /** Dismissed without choosing: nothing plays. */
  onClose: () => void;
}

/**
 * Resume or start again, asked before Play plays something already begun.
 *
 * Plex's shape (Dan, 2026-09-22): two rows, "Resume from 1:02:33" on top and focused, "Play from
 * beginning" under it, and dismissing plays nothing. It replaces a dialog with a paragraph of
 * explanation and two buttons side by side, which put the usual answer second. Not used on TV,
 * whose details page asks the same question through its navigation-based option modal.
 */
export const ResumeChooser: React.FC<Props> = ({
  visible,
  title,
  positionTicks,
  onResume,
  onRestart,
  onClose,
}) => {
  const { t } = useTranslation();
  return (
    <Dialog visible={visible} onClose={onClose} title={title}>
      <View style={{ marginHorizontal: -16 }}>
        <MenuItem
          testID='resume-from-position'
          icon='play'
          label={t("item.resume_from", {
            time: formatResumePosition(positionTicks),
          })}
          autoFocus
          onPress={onResume}
        />
        <MenuItem
          testID='resume-from-start'
          icon='refresh'
          label={t("item.play_from_beginning")}
          onPress={onRestart}
        />
      </View>
    </Dialog>
  );
};
