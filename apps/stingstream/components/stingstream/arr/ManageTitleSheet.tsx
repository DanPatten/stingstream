import { Dialog } from "@/components/common/Dialog";
import { ManageTitleFields } from "./ManageTitleFields";

/**
 * What this server does about one title, opened from the title's own page.
 *
 * The controls themselves are {@link ManageTitleFields}, because a request opens the same three
 * questions from inside the sheet that edits it. This is the details page's way in: the overflow
 * menu, and only when `useArrTitle` found a row — on a pooled library most of what is on screen is
 * held by somebody else's node and tracked by no manager here, and a control that can only fail is
 * worse than no control.
 */
export function ManageTitleSheet({
  kind,
  providerId,
  title,
  monitored,
  profileName,
  visible,
  onClose,
  onRemovedWithFiles,
}: {
  kind: "movie" | "series";
  providerId: number;
  title: string;
  monitored: boolean;
  /** The profile the title is on now, so the select shows it rather than only changing it. */
  profileName?: string;
  visible: boolean;
  onClose: () => void;
  onRemovedWithFiles: () => void;
}) {
  return (
    <Dialog visible={visible} onClose={onClose} title={title}>
      <ManageTitleFields
        kind={kind}
        providerId={providerId}
        title={title}
        monitored={monitored}
        profileName={profileName}
        active={visible}
        onDone={onClose}
        onRemovedWithFiles={onRemovedWithFiles}
      />
    </Dialog>
  );
}
