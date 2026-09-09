import { useAtom, useAtomValue } from "jotai";
import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { toast } from "sonner-native";
import {
  pendingAccountSaveAtom,
  useJellyfin,
  userAtom,
} from "@/providers/JellyfinProvider";
import { writeErrorLog } from "@/utils/log";

/**
 * Saves the account a login asked to keep, once the session exists.
 *
 * ## Why this renders nothing any more
 *
 * Dan: *"lets default save login and keep the user logged in for 1 year. remove this screen"* —
 * the screen being the protection picker, which asked *"No protection / PIN code / Re-enter
 * password"* before it would save anything.
 *
 * It was a question in the wrong place. Somebody who has just ticked "keep me signed in" has said
 * what they want; being asked to choose a security model before the app will honour it is a
 * consent dialog dressed as a setting, and the answer was **No protection** almost every time —
 * which is what "keep me signed in" already means. A PIN or a password on top of a saved account
 * is a real feature for a shared television, and it still exists on TV
 * (`components/login/TVSaveAccountModal.tsx`), where several people genuinely share one screen.
 *
 * So on a phone and in a browser the save just happens, with `securityType: "none"`.
 *
 * It still lives here rather than in the login screen for the reason it always did: that screen
 * unmounts the moment the session exists, so it cannot be the thing that runs afterwards.
 */
export const PendingAccountSave: React.FC = () => {
  const [pending, setPending] = useAtom(pendingAccountSaveAtom);
  const user = useAtomValue(userAtom);
  const { saveCurrentAccount } = useJellyfin();
  const { t } = useTranslation();

  // A logout before the save lands drops the intent — it must not resurface on the next
  // (possibly different) login.
  useEffect(() => {
    if (!user && pending) setPending(null);
  }, [user, pending, setPending]);

  useEffect(() => {
    if (Platform.isTV || !pending || !user) return;
    const serverName = pending.serverName;
    setPending(null);
    saveCurrentAccount({ securityType: "none", serverName }).catch((error) => {
      writeErrorLog(`Failed to save account: ${error?.message ?? error}`);
      toast.error(t("save_account.not_saved"));
    });
  }, [pending, user, setPending, saveCurrentAccount, t]);

  return null;
};
