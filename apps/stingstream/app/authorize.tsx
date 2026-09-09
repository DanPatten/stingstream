import { useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Text } from "@/components/common/Text";
import { AuthCard } from "@/components/login/AuthCard";
import { tokens } from "@/constants/theme";
import { useNodeContext } from "@/hooks/useNodeContext";
import { vouchForMe } from "@/lib/stingstream/identityApi";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  buildReturnUrl,
  fragmentFromLocation,
  parseAuthorizeRequest,
} from "@/utils/identity/handoff";

/**
 * `/authorize` — somebody else's server is asking this one to say who you are.
 *
 * This is the middle of the cross-server sign-in, and it runs on **your own** server. Another
 * server sent you here with its node id and a nonce; this page signs you in if you are not
 * already, shows you which server is asking, and — only when you press the button — has this node
 * sign a short statement and sends you back with it.
 *
 * ## Why the page exists at all
 *
 * So that your password is typed on your own origin. The alternative was the other server's page
 * posting your credentials to yours, which needs your node to accept credentialed cross-origin
 * requests from anywhere, and asks somebody to type their password into a page a stranger's
 * machine served.
 *
 * ## What it is careful about
 *
 * * **The fragment is read during render**, before any effect can run and before the router can
 *   navigate — the same reason `/join` does it, and the same failure if it does not.
 * * **It is a button, not an effect.** Signing the assertion is the whole decision, and a page that
 *   did it on arrival would be a page that could be triggered by a link. The audience is named on
 *   screen before anything is signed.
 * * **This route lives outside `(auth)`**, like `/join`, and is exempted by name in
 *   `useProtectedRoute`. Somebody arriving here may have no session on this server yet, and the
 *   guard's other half would bounce a signed-in visitor to Home and tear the screen down.
 */
export default function AuthorizePage() {
  const { t } = useTranslation();
  const router = useRouter();
  const nodeContext = useNodeContext();
  const user = useAtomValue(userAtom);
  const api = useAtomValue(apiAtom);

  // During render, not in an effect. See the note above.
  const [request] = useState(() =>
    parseAuthorizeRequest(fragmentFromLocation()),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = useCallback(async () => {
    if (!request || !nodeContext || busy) return;
    setBusy(true);
    setError(null);
    try {
      const signed = await vouchForMe(
        nodeContext.origin,
        { audience: request.audience, nonce: request.nonce },
        api?.accessToken,
      );

      const back = buildReturnUrl(
        request.returnTo,
        signed.assertion,
        request.link,
      );
      if (!back) {
        setError(t("identity.authorize_nowhere_to_return"));
        return;
      }

      if (Platform.OS === "web") {
        // A different origin, so a full navigation rather than a router push.
        (
          globalThis as { location?: { assign?: (u: string) => void } }
        ).location?.assign?.(back);
        return;
      }

      const WebBrowser = await import("expo-web-browser");
      await WebBrowser.openBrowserAsync(back);
    } catch (e) {
      setError((e as Error)?.message ?? t("identity.authorize_failed"));
    } finally {
      setBusy(false);
    }
  }, [api?.accessToken, busy, nodeContext, request, t]);

  // A link whose fragment did not survive being pasted, or somebody who typed the path.
  if (!request) {
    return (
      <AuthCard>
        <Text variant='title' weight='bold'>
          {t("identity.authorize_problem_title")}
        </Text>
        <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
          {t("identity.authorize_incomplete")}
        </Text>
        <Button
          variant='secondary'
          size='lg'
          onPress={() => router.replace("/")}
          style={{ marginTop: 20 }}
        >
          {t("identity.authorize_go_home")}
        </Button>
      </AuthCard>
    );
  }

  // Not signed in *here* yet. Sent to the ordinary sign-in rather than given a second login form:
  // this is their own server, the fragment survives the round trip because the browser keeps it
  // across a same-origin navigation back, and one login screen is one login screen.
  if (!user?.Id) {
    return (
      <AuthCard>
        <Text variant='title' weight='bold'>
          {t("identity.authorize_title")}
        </Text>
        <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
          {t("identity.authorize_sign_in_first", {
            server: request.serverName ?? t("identity.authorize_other_server"),
          })}
        </Text>
        <Button
          variant='primary'
          size='lg'
          onPress={() => router.replace("/login")}
          style={{ marginTop: 20 }}
        >
          {t("identity.authorize_sign_in")}
        </Button>
      </AuthCard>
    );
  }

  if (!nodeContext) {
    // No marker means this bundle is not being served by a node, so there is nothing here that can
    // sign anything. Says so rather than failing at the button.
    return (
      <AuthCard>
        <Text variant='title' weight='bold'>
          {t("identity.authorize_problem_title")}
        </Text>
        <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
          {t("identity.authorize_no_node")}
        </Text>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <Text variant='title' weight='bold'>
        {t("identity.authorize_title")}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t("identity.authorize_body", {
          server: request.serverName ?? t("identity.authorize_other_server"),
          name: user.Name ?? "",
        })}
      </Text>

      {/* What is actually being handed over, in the order somebody would ask. Naming the audience
          is the whole reason this is a screen and not a redirect. */}
      <View
        style={{
          marginTop: 16,
          padding: 12,
          borderRadius: 12,
          backgroundColor: tokens.color.bg["2"],
          gap: 6,
        }}
      >
        <Text variant='caption' tone='tertiary' weight='medium'>
          {t("identity.authorize_shares_title")}
        </Text>
        <Text variant='body'>{t("identity.authorize_shares_body")}</Text>
        <Text variant='caption' tone='tertiary' style={{ marginTop: 4 }}>
          {t("identity.authorize_not_shared")}
        </Text>
      </View>

      <FormError message={error} />

      <Button
        testID='identity-authorize-approve'
        variant='primary'
        size='lg'
        loading={busy}
        disabled={busy}
        onPress={() => void approve()}
        style={{ marginTop: 20 }}
      >
        {busy ? (
          <ActivityIndicator />
        ) : (
          t("identity.authorize_approve", {
            server: request.serverName ?? t("identity.authorize_other_server"),
          })
        )}
      </Button>
      <Button
        variant='ghost'
        size='sm'
        disabled={busy}
        onPress={() => router.replace("/")}
        style={{ marginTop: 8 }}
      >
        {t("identity.authorize_decline")}
      </Button>
    </AuthCard>
  );
}
