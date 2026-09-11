import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { requestChallenge } from "@/lib/stingstream/identityApi";
import {
  buildAuthorizeUrl,
  returnTargetFromLocation,
} from "@/utils/identity/handoff";
import { resolveServerOrigin } from "@/utils/identity/resolveServer";

/**
 * "I already run StingStream" — the start of signing in with your own server.
 *
 * ## What happens, and where
 *
 * Three steps, and the order is the point:
 *
 * 1. **This** server (the one being signed in to) is asked for a nonce, and answers with its own
 *    node id as well. That id is what the assertion gets bound to, and it is why an assertion
 *    handed to one server is worthless at any other.
 * 2. The address somebody types is resolved by asking it for `/sidedoor/v1/hello` — HTTPS first,
 *    then plain HTTP — so a missing scheme is not a dead end. `resolveOwnServer` below says why it
 *    is that route and not the one the sign-in screen uses.
 * 3. The browser **leaves**, to their own server's `/authorize`.
 *
 * ## Why it leaves rather than posting
 *
 * The obvious alternative is for this page to post their password to their own server. That would
 * mean their server accepting credentialed cross-origin requests from any origin, and it would
 * mean somebody typing their password into a page served by a machine that is not theirs. Sending
 * them to their own server keeps the password on its own origin — and it is what Dan described:
 * *"entering the URL of their instance and then going to an auth flow"*.
 *
 * Everything in both hops rides in the URL fragment, which a browser never sends. See
 * `utils/identity/handoff.ts`.
 *
 * The address probe itself is `utils/identity/resolveServer.ts`, shared with Settings, Servers,
 * *Add server* -- the same act started from the other end.
 */
export const SignInWithOwnServer: React.FC<{
  /** This server's origin — the one being signed in to. */
  nodeOrigin: string;
  /**
   * An invite token to carry through, when this is the first time.
   *
   * Round-tripped through the other server rather than held here: this page is replaced by a
   * navigation to another origin, so anything it was holding is gone by the time the answer comes
   * back.
   */
  inviteToken?: string | null;
  /** What this server calls itself, for the consent screen on the other end. */
  serverName?: string | null;
  /**
   * Also ask for the two servers to be linked.
   *
   * True from the invite flow, because that is what Dan asked for: *"signing in with their own
   * server will re-use their same login on this new server AND submit a request to link their
   * server to this one"*. False from the ordinary sign-in, where the person already has an account
   * here and asking again on every sign-in would be noise — Settings is where they ask later.
   */
  requestLink?: boolean;
  onCancel?: () => void;
}> = ({ nodeOrigin, inviteToken, serverName, requestLink, onCancel }) => {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    const typed = address.trim();
    if (!typed || busy) return;

    setBusy(true);
    setError(null);
    try {
      // The challenge first. If this server cannot start a sign-in there is no point sending
      // anybody anywhere, and the error belongs on the screen they are still looking at.
      const challenge = await requestChallenge(nodeOrigin);

      const found = await resolveServerOrigin(typed);
      if (!found) {
        setError(t("identity.own_server_not_found"));
        return;
      }

      // Already their node's root: `/authorize` is served by the gateway at the top level, the
      // same as `/join`, and the side door answers there too.
      const url = buildAuthorizeUrl(found, {
        audience: challenge.audience,
        nonce: challenge.nonce,
        returnTo: returnTargetFromLocation() ?? nodeOrigin,
        serverName: serverName ?? challenge.serverName,
        invite: inviteToken ?? undefined,
        link: requestLink,
      });

      if (!url) {
        setError(t("identity.own_server_not_found"));
        return;
      }

      if (Platform.OS === "web") {
        // A full navigation, not a router push: the destination is a different origin, and the
        // router only knows about this one.
        (
          globalThis as { location?: { assign?: (u: string) => void } }
        ).location?.assign?.(url);
        return;
      }

      // On a phone the app is not a page, so there is no origin to come back to. The browser
      // sheet hands the redirect back to us instead.
      const WebBrowser = await import("expo-web-browser");
      await WebBrowser.openBrowserAsync(url);
    } catch (e) {
      setError((e as Error)?.message ?? t("identity.own_server_failed"));
    } finally {
      setBusy(false);
    }
  }, [address, busy, inviteToken, nodeOrigin, requestLink, serverName, t]);

  return (
    <View style={{ gap: 12 }}>
      <View>
        <Text variant='body' weight='semibold'>
          {t("identity.own_server_title")}
        </Text>
        <Text variant='caption' tone='secondary' style={{ marginTop: 4 }}>
          {t("identity.own_server_detail")}
        </Text>
      </View>

      <Input
        testID='identity-own-server-url'
        placeholder={t("identity.own_server_placeholder")}
        value={address}
        onChangeText={setAddress}
        autoCapitalize='none'
        autoCorrect={false}
        autoComplete='off'
        keyboardType='url'
        returnKeyType='go'
        editable={!busy}
        onSubmitEditing={() => void start()}
      />

      <FormError message={error} />

      <Button
        testID='identity-own-server-continue'
        variant='primary'
        size='lg'
        loading={busy}
        disabled={busy || address.trim().length === 0}
        onPress={() => void start()}
      >
        {t("identity.own_server_continue")}
      </Button>

      {onCancel ? (
        <Button variant='ghost' size='sm' onPress={onCancel} disabled={busy}>
          {t("identity.own_server_cancel")}
        </Button>
      ) : null}
    </View>
  );
};
