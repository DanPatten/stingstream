import { useRouter } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, View } from "react-native";
import { Text } from "@/components/common/Text";
import { tokens } from "@/constants/theme";
import { inviteCodeFromLocation } from "@/utils/mesh/inviteLink";
import { rememberPendingInvite } from "@/utils/mesh/pendingInvite";

/**
 * `/join` — where an invite link lands.
 *
 * A link is `https://<host>/join#<code>`, and the code is in the **fragment**, which a browser
 * never sends to a server. So the node cannot act on it, and did not need a route for it either:
 * the gateway's SPA fallback already serves the app for any path it does not recognise. This file
 * is the whole receiving end.
 *
 * It does two things and neither of them is joining. It takes the code out of the address **during
 * render**, before any effect can run and before the session guard can navigate — read it in an
 * effect and a signed-in user is already on their way to Home with the fragment gone. Then it sends
 * them to the Join screen, which has the confirmation, the errors and the administrator check that
 * joining needs.
 *
 * It sits inside `(auth)` on purpose. `useProtectedRoute` sends a signed-out visitor from here to
 * sign in, which is correct — joining is an administrator action on their own server, and there is
 * no version of this that works without a session. Landing outside the group would have been worse:
 * the guard bounces a *signed-in* user off any route outside `(auth)`, so the screen would have
 * been torn down under the person it was meant to serve.
 */
export default function JoinFromLinkPage() {
  const { t } = useTranslation();
  const router = useRouter();

  // During render, not in an effect. See above.
  rememberPendingInvite(inviteCodeFromLocation());

  useEffect(() => {
    router.replace("/settings/groups/join");
  }, [router]);

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        backgroundColor: tokens.color.bg["0"],
      }}
    >
      <ActivityIndicator />
      <Text variant='caption' tone='secondary'>
        {t("sharing.join_opening_link")}
      </Text>
    </View>
  );
}
