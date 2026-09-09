import type React from "react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  getAppDialog,
  settleAppDialog,
  subscribeAppDialog,
} from "@/utils/appDialog";
import { Dialog } from "./Dialog";
import { Text } from "./Text";

/**
 * Draws whatever `utils/appDialog.ts` is asking.
 *
 * Mounted once, at the root, so `confirmDestructive()` can be awaited from any event handler
 * anywhere without that screen having to hold dialog state or render anything itself. See
 * `utils/appDialog.ts` for why the browser's own `confirm` is not an option.
 *
 * The cancel label is translated here rather than passed in: it is "Cancel" at every call site,
 * and a helper that took it as an argument collected a hard-coded English one at half of them.
 */
export const AppDialogHost: React.FC = () => {
  const { t } = useTranslation();
  const request = useSyncExternalStore(
    subscribeAppDialog,
    getAppDialog,
    getAppDialog,
  );

  return (
    <Dialog
      // Keyed on the request so two questions in a row cannot share one dialog's state.
      key={request?.id ?? "idle"}
      visible={!!request}
      onClose={() => settleAppDialog(false)}
      title={request?.title}
      actions={[
        { label: t("common.cancel"), onPress: () => settleAppDialog(false) },
        {
          label: request?.confirmLabel ?? t("common.ok"),
          testID: "app-dialog-confirm",
          variant: request?.destructive ? "danger" : "primary",
          onPress: () => settleAppDialog(true),
        },
      ]}
    >
      {request?.message ? (
        <Text variant='body' tone='secondary'>
          {request.message}
        </Text>
      ) : null}
    </Dialog>
  );
};
