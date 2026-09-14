import { useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { AuthCard } from "@/components/login/AuthCard";
import { goToServer } from "@/components/stingstream/mesh/openOrCopy";
import { ShareLibrariesPicker } from "@/components/stingstream/mesh/ShareLibrariesPicker";
import { IDENTITY_KDF_ITERATIONS } from "@/constants/Values";
import {
  jellyfinUrlFor,
  type NodeContext,
  useNodeContext,
} from "@/hooks/useNodeContext";
import { createConnectionInvite } from "@/lib/stingstream/connections";
import { vouchForMe } from "@/lib/stingstream/identityApi";
import {
  apiAtom,
  getUserFromStorage,
  secretToSend,
  useJellyfin,
  userAtom,
} from "@/providers/JellyfinProvider";
import {
  buildReturnUrl,
  fragmentFromLocation,
  parseAuthorizeRequest,
} from "@/utils/identity/handoff";
import { deriveVerifier, newSalt } from "@/utils/identity/verifier";
import { checkJellyfinServer } from "@/utils/jellyfin/checkServer";
import { storage } from "@/utils/mmkv";
import { APP_VERSION } from "@/utils/version";

/**
 * Check a password on this server without taking over the session this browser already holds.
 *
 * Its own device id, so Jellyfin opens a second session rather than replacing the one every tab is
 * using, and that second session is logged out again at once: it existed only to answer "is this
 * the password".
 */
async function checkPassword(
  node: NodeContext,
  basePath: string | undefined,
  username: string,
  password: string,
  refused: string,
): Promise<void> {
  const base = jellyfinUrlFor(node);
  const secret = await secretToSend(basePath ?? base, username, password);
  const deviceId = `authorize-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const header = (token?: string) =>
    `MediaBrowser Client="StingStream", Device="Sign-in check", DeviceId="${deviceId}", Version="${APP_VERSION}"${token ? `, Token="${token}"` : ""}`;

  const res = await fetch(`${base}/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: header() },
    body: JSON.stringify({ Username: username, Pw: secret }),
  });
  if (!res.ok) throw new Error(refused);

  const body = (await res.json().catch(() => null)) as {
    AccessToken?: string;
  } | null;
  if (body?.AccessToken) {
    void fetch(`${base}/Sessions/Logout`, {
      method: "POST",
      headers: { Authorization: header(body.AccessToken) },
    }).catch(() => undefined);
  }
}

/** What the sign-in step proved, held while an administrator chooses what their server shares. */
interface SignedIn {
  token: string;
  salt: string;
  verifier: string;
}

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
 * ## Connecting the two servers on the way through
 *
 * The invite flow asks for it (`link`). An administrator of this server chooses what it shares, this
 * server makes an invite for the other one, and its code goes back beside the assertion, so the one
 * sign-in also connects the servers. Dan: *"one user does EVERYTHING once and they are done."* A
 * member of this server skips the step and gets the account only: what this server shares is not
 * theirs to decide.
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
  const [signedIn, setSignedIn] = useState<SignedIn | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);

  const serverName =
    request?.serverName ?? t("identity.authorize_other_server");

  /** Sign the assertion and go back, with an invite when there is one. */
  const finish = useCallback(
    async (proved: SignedIn, linkCode?: string) => {
      if (!request || !nodeContext) return;
      const signed = await vouchForMe(
        nodeContext.origin,
        { audience: request.audience, nonce: request.nonce },
        proved.token,
      );

      const back = buildReturnUrl(request.returnTo, signed.assertion, {
        linkCode,
        // Straight back out. The far side needs it to admit somebody for the first time, and the
        // page that held it is gone.
        invite: request.invite,
        credential: {
          salt: proved.salt,
          verifier: proved.verifier,
          iterations: IDENTITY_KDF_ITERATIONS,
        },
      });
      if (!back) {
        setError(t("identity.authorize_nowhere_to_return"));
        return;
      }
      await goToServer(back);
    },
    [nodeContext, request, t],
  );

  const approve = useCallback(async () => {
    if (!request || !nodeContext || busy) return;
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      // Always checked, session or not: this is what proves the password the verifier is about to be
      // built from is really theirs.
      let token: string | undefined;
      const existing = storage.getString("token");
      if (
        existing &&
        user?.Name &&
        user.Name.trim().toLowerCase() === username.trim().toLowerCase()
      ) {
        // **Already signed in here as this person: check, do not sign in again.** A second sign-in
        // from this browser uses the same device id, and Jellyfin replaces that device's session.
        // Every other tab on this server was holding the old one, and the first to hear a 401 tore
        // the session down in shared storage, taking the one this page had just been given with it.
        // Linking a server signed its owner out of that server. Found end to end in a browser.
        await checkPassword(
          nodeContext,
          api?.basePath,
          username.trim(),
          password,
          t("identity.authorize_failed"),
        );
        token = existing;
      } else {
        // Pointed at this server before it can hold a session on it — the same step `/join` takes.
        if (!api?.basePath) {
          const found = await checkJellyfinServer(jellyfinUrlFor(nodeContext));
          if (!found) throw new Error(t("login.could_not_connect_to_server"));
          await setServer({ address: found.url });
        }
        await login(username.trim(), password);
        // Read back rather than taken from `api`, which is the value this render closed over and is
        // one state update behind the line above.
        token = storage.getString("token") ?? undefined;
      }
      if (!token) throw new Error(t("identity.authorize_failed"));

      const salt = await newSalt();
      const verifier = await deriveVerifier(
        password,
        salt,
        IDENTITY_KDF_ITERATIONS,
      );
      const proved = { token, salt, verifier };

      if (request.link && getUserFromStorage()?.Policy?.IsAdministrator) {
        setSignedIn(proved);
        return;
      }
      await finish(proved);
    } catch (e) {
      setError((e as Error)?.message ?? t("identity.authorize_failed"));
    } finally {
      setBusy(false);
    }
  }, [
    api?.basePath,
    busy,
    finish,
    login,
    nodeContext,
    password,
    request,
    setServer,
    t,
    user?.Name,
    username,
  ]);

  const share = useCallback(async () => {
    if (!signedIn || !nodeContext || busy) return;
    setBusy(true);
    setError(null);
    try {
      const invite = await createConnectionInvite(
        `${nodeContext.origin}${nodeContext.apiPath}`,
        signedIn.token,
        selected,
      );
      await finish(signedIn, invite.code);
    } catch (e) {
      setError((e as Error)?.message ?? t("sharing.add_server_failed"));
    } finally {
      setBusy(false);
    }
  }, [busy, finish, nodeContext, selected, signedIn, t]);

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

  if (signedIn) {
    return (
      <AuthCard>
        <Text variant='title' weight='bold'>
          {t("sharing.share_title")}
        </Text>
        <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
          {t("sharing.share_detail", { server: serverName })}
        </Text>
        <View style={{ marginTop: 20 }}>
          <ShareLibrariesPicker
            selected={selected}
            onChange={setSelected}
            disabled={busy}
          />
        </View>
        <FormError message={error} />
        <Button
          testID='identity-authorize-share'
          variant='primary'
          size='lg'
          loading={busy}
          disabled={busy}
          onPress={() => void share()}
          style={{ marginTop: 20 }}
        >
          {t("sharing.continue")}
        </Button>
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
