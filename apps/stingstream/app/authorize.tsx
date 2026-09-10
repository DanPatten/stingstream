import { useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { AuthCard } from "@/components/login/AuthCard";
import { IDENTITY_KDF_ITERATIONS } from "@/constants/Values";
import { jellyfinUrlFor, useNodeContext } from "@/hooks/useNodeContext";
import { vouchForMe } from "@/lib/stingstream/identityApi";
import { apiAtom, useJellyfin, userAtom } from "@/providers/JellyfinProvider";
import {
  buildReturnUrl,
  fragmentFromLocation,
  parseAuthorizeRequest,
} from "@/utils/identity/handoff";
import { deriveVerifier, newSalt } from "@/utils/identity/verifier";
import { checkJellyfinServer } from "@/utils/jellyfin/checkServer";
import { storage } from "@/utils/mmkv";

/**
 * `/authorize` — somebody else's server is asking this one to say who you are.
 *
 * This is the middle of the cross-server sign-in, and it runs on **your own** server. Another
 * server sent you here with its node id and a nonce; you sign in, and this node signs a short
 * statement saying who you are and sends you back with it.
 *
 * ## Why the page exists at all
 *
 * So that your password is typed on your own origin. The alternative was the other server's page
 * posting your credentials to yours, which needs your node to accept credentialed cross-origin
 * requests from anywhere, and asks somebody to type their password into a page a stranger's
 * machine served.
 *
 * ## Why it asks for the password even when you are already signed in
 *
 * Because the password is the input to something, not just a check. The other server needs a way to
 * let you back in when this one is off, and what it gets is `PBKDF2(password)` derived right here —
 * `utils/identity/verifier.ts`. Built from a password that was never confirmed, it would be a
 * password nobody could reproduce, so this authenticates first and derives from what worked.
 *
 * This also replaced a bounce to `/login`, which lost the fragment on the way and left the request
 * unfinishable.
 *
 * ## The copy
 *
 * A title, one line, two fields, a button — the shape every sign-in and link page in this app
 * uses. The wording is a consent screen's, not a challenge's: it said *"Prove who you are"* over
 * *"Sign in, and {{server}} will be told your name. Not your password."* until Dan called it out —
 * *"isnt professional and doesnt match AAA software linking screens"*. Both faults are worth naming
 * so they do not come back: an imperative that reads as an accusation, and a defensive sentence
 * fragment about what is *not* sent. What a reader needs is what happens if they continue, said
 * once and calmly, which is what the two strings say now.
 *
 * ## What it is careful about
 *
 * * **The fragment is read during render**, before any effect can run and before the router can
 *   navigate — the same reason `/join` does it, and the same failure if it does not.
 * * **It is a button, not an effect.** Signing the assertion is the whole decision, and a page that
 *   did it on arrival would be a page that could be triggered by a link. The audience is named on
 *   screen before anything is signed.
 * * **This route lives outside `(auth)`**, like `/join`, and is exempted by name in
 *   `useProtectedRoute`.
 */
export default function AuthorizePage() {
  const { t } = useTranslation();
  const router = useRouter();
  const nodeContext = useNodeContext();
  const user = useAtomValue(userAtom);
  const api = useAtomValue(apiAtom);
  const { login, setServer } = useJellyfin();

  // During render, not in an effect. See the note above.
  const [request] = useState(() =>
    parseAuthorizeRequest(fragmentFromLocation()),
  );

  const [username, setUsername] = useState(user?.Name ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const serverName =
    request?.serverName ?? t("identity.authorize_other_server");

  const approve = useCallback(async () => {
    if (!request || !nodeContext || busy) return;
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      // Pointed at this server before it can hold a session on it — the same step `/join` takes.
      if (!api?.basePath) {
        const found = await checkJellyfinServer(jellyfinUrlFor(nodeContext));
        if (!found) throw new Error(t("login.could_not_connect_to_server"));
        await setServer({ address: found.url });
      }

      // Always, session or not: this is what proves the password the verifier is about to be built
      // from is really theirs.
      await login(username.trim(), password);

      // Read back rather than taken from `api`, which is the value this render closed over and is
      // one state update behind the line above.
      const token = storage.getString("token");
      if (!token) throw new Error(t("identity.authorize_failed"));

      const salt = await newSalt();
      const verifier = await deriveVerifier(
        password,
        salt,
        IDENTITY_KDF_ITERATIONS,
      );

      const signed = await vouchForMe(
        nodeContext.origin,
        { audience: request.audience, nonce: request.nonce },
        token,
      );

      const back = buildReturnUrl(request.returnTo, signed.assertion, {
        link: request.link,
        // Straight back out. The far side needs it to admit somebody for the first time, and the
        // page that held it is gone.
        invite: request.invite,
        credential: { salt, verifier, iterations: IDENTITY_KDF_ITERATIONS },
      });
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
  }, [
    api?.basePath,
    busy,
    login,
    nodeContext,
    password,
    request,
    setServer,
    t,
    username,
  ]);

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
        {t("identity.authorize_body", { server: serverName })}
      </Text>

      <View style={{ marginTop: 24, gap: 12 }}>
        <Input
          testID='identity-authorize-username'
          aria-label={t("login.username_placeholder")}
          placeholder={t("login.username_placeholder")}
          value={username}
          onChangeText={setUsername}
          autoCapitalize='none'
          autoCorrect={false}
          autoComplete='username'
          textContentType='username'
          returnKeyType='next'
          maxLength={500}
          editable={!busy}
        />
        <Input
          testID='identity-authorize-password'
          aria-label={t("login.password_placeholder")}
          placeholder={t("login.password_placeholder")}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize='none'
          autoComplete='current-password'
          textContentType='password'
          returnKeyType='go'
          maxLength={500}
          editable={!busy}
          onSubmitEditing={() => void approve()}
        />
      </View>

      <FormError message={error} />

      <Button
        testID='identity-authorize-approve'
        variant='primary'
        size='lg'
        loading={busy}
        disabled={busy || !username.trim() || !password}
        onPress={() => void approve()}
        style={{ marginTop: 20 }}
      >
        {busy ? (
          <ActivityIndicator />
        ) : (
          t("identity.authorize_approve", { server: serverName })
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
