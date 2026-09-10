import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, View } from "react-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { AuthCard } from "@/components/login/AuthCard";
import { SignInWithOwnServer } from "@/components/stingstream/identity/SignInWithOwnServer";
import {
  InviteAccountForm,
  InviteLibraryList,
} from "@/components/stingstream/invites/InviteAccountForm";
import { tokens } from "@/constants/theme";
import { jellyfinUrlFor, useNodeContext } from "@/hooks/useNodeContext";
import { useTheme } from "@/hooks/useTheme";
import { signInWithAssertion } from "@/lib/stingstream/identityApi";
import {
  acceptInvite,
  type InviteDescription,
  InviteRequestError,
  lookupInvite,
} from "@/lib/stingstream/invitesApi";
import { apiAtom, useJellyfin, userAtom } from "@/providers/JellyfinProvider";
import {
  clearFragment,
  fragmentFromLocation,
  parseAssertion,
  parseReturnCredential,
  parseReturnInvite,
  parseReturnLink,
} from "@/utils/identity/handoff";
import { checkJellyfinServer } from "@/utils/jellyfin/checkServer";
import { inviteCodeFromLocation } from "@/utils/mesh/inviteLink";
import { rememberPendingInvite } from "@/utils/mesh/pendingInvite";

/**
 * `/join` — where every invite link lands, of either kind.
 *
 * There are two things a link can carry and they are told apart by asking the server, not by
 * looking at the string:
 *
 * - **A person invite.** Somebody was invited to *this* server and has no account anywhere. They
 *   get a create-account screen, and the account is made here.
 * - **A group invite.** One server was invited to link with another. That is an administrator
 *   action on their own server, so the code is remembered and they are sent to the Join screen deep
 *   in Settings — which is what this route did before person invites existed.
 *
 * `POST /invites/lookup` answers the question: a `404` means no invite here has that token, which
 * for a base58 group code is exactly right. Guessing from the shape of the string would be
 * guessing, and the two alphabets overlap.
 *
 * **This route lives outside `(auth)`, and that is the whole reason it moved.** A person invite is
 * opened by definition by somebody who cannot sign in, and inside `(auth)` the session guard sent
 * them straight to a login form for an account that does not exist yet. Outside it, the guard's
 * other half would bounce a *signed-in* visitor to Home and tear the screen down under them — so
 * `useProtectedRoute` exempts this route by name, the same way it exempts the top-shelf launcher,
 * and the page below decides what each of the two should see.
 */
export default function JoinFromLinkPage() {
  const { color } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const nodeContext = useNodeContext();
  const { adoptSession, login, setServer } = useJellyfin();
  const user = useAtomValue(userAtom);
  const api = useAtomValue(apiAtom);

  // During render, not in an effect: a fragment has to be read before anything can navigate, and
  // an effect runs a beat too late on web. Harmless to call repeatedly -- it only remembers a
  // non-empty code, and the group path is the only thing that consumes it.
  const [code] = useState(() => inviteCodeFromLocation());

  // Read from the same fragment, and read first. Somebody coming *back* from their own server has
  // an assertion where an invite code would be; `inviteCodeFromLocation` would otherwise hand the
  // whole `assertion=…` pair to `lookupInvite` as if it were a token.
  const [assertion] = useState(() => parseAssertion(fragmentFromLocation()));
  // Their answer to "and link your server?", carried back with the assertion.
  const [wantsLink] = useState(() => parseReturnLink(fragmentFromLocation()));
  /**
   * The password credential their own server derived, for this server to keep.
   *
   * Read in the same breath as the assertion, and then the whole fragment is dropped out of the
   * address bar below. Unlike the assertion this one does not expire — it becomes their password
   * here — so leaving it in the browser's history would be leaving a credential lying about.
   */
  const [credential] = useState(() =>
    parseReturnCredential(fragmentFromLocation()),
  );
  /** The invite that started this, handed back by their server with the assertion. */
  const [returnedInvite] = useState(() =>
    parseReturnInvite(fragmentFromLocation()),
  );

  const [phase, setPhase] = useState<
    | "checking"
    | "person"
    | "group"
    | "signed-in"
    | "problem"
    | "done"
    // The person invite is open and they have said they already run a server: the same screen,
    // with the address form instead of the password form.
    | "own-server"
  >("checking");

  /**
   * Whether they already had a session when they opened the link — read **once**, at mount.
   *
   * Dan: *"i accepted an invite, entered a password and got this. this is 100% NOT TRUE at all."*
   * Accepting an invite signs you in, so re-reading the live session afterwards meant a successful
   * sign-up re-ran the decision below, found a session, found its own invite now spent, and told
   * the person they were already signed in — as themselves, a second earlier.
   *
   * "Already signed in" is only ever true of somebody who arrived that way, which is what this
   * remembers.
   */
  const [wasSignedIn] = useState(() => Boolean(user?.Id));
  const [invite, setInvite] = useState<InviteDescription | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * Whether the assertion below has already been presented.
   *
   * **A nonce is spent by the first attempt**, so a second one is refused — and the effect that
   * presents it depends on `api?.basePath`, which the *success* path changes by pointing the app
   * at this server. That re-ran it, and the second run replaced a sign-in that had worked with
   * "this invite cannot be used": the account existed, the person was told it did not.
   *
   * A ref rather than state, and set before the first `await`, because two runs of the effect in
   * the same tick must not both get past it.
   */
  const presented = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const decide = async () => {
      // Coming back from their own server, with a signed assertion instead of a code. Nothing
      // below applies: there is no invite to look up, because the invite (if there was one) went
      // out with the request and is coming back inside it.
      if (assertion && nodeContext) {
        if (presented.current) return;
        presented.current = true;
        try {
          // Before the request goes out, not after it comes back: what is in the fragment is this
          // person's password on this server from here on, and it does not expire.
          clearFragment();

          const session = await signInWithAssertion(nodeContext.origin, {
            assertion,
            // The invite that started this, come back with the answer. The first sign-in is
            // refused without it, and this page no longer holds the one it sent.
            inviteToken: returnedInvite,
            requestLink: wantsLink,
            salt: credential?.salt,
            verifier: credential?.verifier,
            iterations: credential?.iterations,
          });

          // **No `cancelled` check here, and that is the whole point.** The nonce is spent the
          // moment that call returns, so there is no second attempt to fall back on: abandoning
          // the work now would leave somebody with an account on this server, no session, and a
          // spinner. And this effect *does* get torn down mid-flight — `adoptSession` and
          // `setServer` are rebuilt whenever the provider re-renders, which it does while the
          // request is in the air. That is what left the screen on "Opening your invite…" after a
          // sign-in that had already succeeded.

          // The app has to be pointed at this server before it can hold a session on it — the same
          // step `handleCreateAccount` takes, for the same reason.
          if (!api?.basePath) {
            const target = jellyfinUrlFor(nodeContext);
            const result = await checkJellyfinServer(target);
            if (!result)
              throw new Error(t("login.could_not_connect_to_server"));
            await setServer({ address: result.url });
          }

          // `adoptSession`, not `login`: there is no password here and there never was. This is
          // the same ending Quick Connect and a passkey have — a token and a user, with nothing
          // left to verify.
          adoptSession(session.accessToken!, session.user as UserDto);
          setPhase("done");
        } catch (e) {
          // Reported for the same reason the success above is not abandoned: this attempt was the
          // only one, and a silent spinner is the worst of the three outcomes.
          setProblem(
            e instanceof Error && e.message
              ? e.message
              : t("invites.error_unexpected"),
          );
          setPhase("problem");
        }
        return;
      }

      if (!code) {
        // A link whose fragment did not survive being pasted, or somebody who typed `/join`. Say
        // so rather than sending them somewhere that will fail differently.
        if (!cancelled) {
          setProblem(t("invites.error_no_code"));
          setPhase("problem");
        }
        return;
      }

      // No marker means this bundle is not being served by a node -- Metro, a static host, or a
      // phone build. There is nothing to ask, so fall through to the behaviour this route has
      // always had and let the group Join screen deal with the code.
      if (!nodeContext) {
        rememberPendingInvite(code);
        if (!cancelled) setPhase("group");
        return;
      }

      try {
        const described = await lookupInvite(nodeContext.origin, code);
        if (cancelled) return;
        setInvite(described);
        setPhase(wasSignedIn ? "signed-in" : "person");
      } catch (e) {
        if (cancelled) return;

        // Not a person invite. Almost always a group code, which is what this route used to
        // assume unconditionally.
        if (e instanceof InviteRequestError && e.kind === "unknown") {
          rememberPendingInvite(code);
          setPhase("group");
          return;
        }

        // It *was* a person invite and cannot be used: spent, expired or withdrawn. The node
        // writes that sentence; it already ends in what to do next.
        setProblem(
          e instanceof Error && e.message
            ? e.message
            : t("invites.error_unexpected"),
        );
        // Unless the visitor is already signed in on this server, in which case a dead end is the
        // wrong answer and "go to sign in" is a nonsense one. Dan hit exactly that: an invite he
        // had already redeemed, a card that said it could not be used, and a button to a sign-in
        // he had done. Somebody with a session does not need this link for anything.
        setPhase(wasSignedIn ? "signed-in" : "problem");
      }
    };

    void decide();
    return () => {
      cancelled = true;
    };
  }, [
    adoptSession,
    api?.basePath,
    assertion,
    code,
    credential,
    nodeContext,
    returnedInvite,
    wantsLink,
    setServer,
    t,
    wasSignedIn,
  ]);

  // The group path leaves this screen entirely. Separate from the effect above so the navigation
  // happens after the phase has actually rendered -- replacing mid-decision races the router.
  useEffect(() => {
    if (phase === "group") router.replace("/settings/servers/join");
    // A new account is signed in by the time this runs, so Home is where they belong. Doing it
    // here rather than inside the submit handler keeps it after the phase has rendered — replacing
    // mid-decision races the router.
    if (phase === "done") router.replace("/");
  }, [phase, router]);

  const handleCreateAccount = useCallback(
    async (username: string, password: string) => {
      if (!nodeContext || !code) throw new Error(t("invites.error_unexpected"));

      await acceptInvite(nodeContext.origin, {
        token: code,
        username,
        password,
      });

      // Sign in with the credentials just chosen rather than adopting the token the endpoint
      // returned, for the reason first-run does the same: the provider's own login path is what
      // stores the session, refreshes settings and moves the app to Home, and it is the path
      // every other sign-in takes.
      if (!api?.basePath) {
        const target = jellyfinUrlFor(nodeContext);
        const result = await checkJellyfinServer(target);
        if (!result) throw new Error(t("login.could_not_connect_to_server"));
        await setServer({ address: result.url });
      }
      await login(username, password, invite?.serverName ?? undefined);
      setPhase("done");
    },
    [api?.basePath, code, invite?.serverName, login, nodeContext, setServer, t],
  );

  if (phase === "checking" || phase === "group" || phase === "done") {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          backgroundColor: color.bg["0"],
        }}
      >
        <ActivityIndicator />
        <Text variant='caption' tone='secondary'>
          {t("sharing.join_opening_link")}
        </Text>
      </View>
    );
  }

  if (phase === "problem") {
    return (
      <AuthCard>
        <Text variant='title' weight='bold'>
          {t("invites.problem_title")}
        </Text>
        <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
          {problem}
        </Text>
        <Button
          variant='secondary'
          size='lg'
          onPress={() => router.replace("/login")}
          style={{ marginTop: 20 }}
        >
          {t("invites.problem_go_to_sign_in")}
        </Button>
      </AuthCard>
    );
  }

  if (phase === "signed-in") {
    return (
      <AuthCard>
        <Text variant='title' weight='bold'>
          {t("invites.already_signed_in_title")}
        </Text>
        {/* Named rather than assumed: somebody may be signed in as one person and holding an
            invite meant for another in the same household, and the account name is the only thing
            that tells them which.

            Two shapes, because there are two ways to arrive here. A *live* invite is a real
            decision — accepting it would make a second account — so it says so and lists what the
            invite opens. An invite that cannot be used is not a decision at all: it says why in the
            node's own words, and the only thing left to do is carry on. */}
        <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
          {invite
            ? t("invites.already_signed_in_body", {
                name: user?.Name ?? "",
                server: invite.serverName,
              })
            : t("invites.already_signed_in_spent", {
                name: user?.Name ?? "",
                reason: problem ?? t("invites.error_unexpected"),
              })}
        </Text>
        {invite ? (
          <InviteLibraryList
            libraries={invite.libraries}
            isAdministrator={invite.isAdministrator}
          />
        ) : null}
        <Button
          variant='primary'
          size='lg'
          onPress={() => router.replace("/(auth)/(tabs)/(home)/")}
          style={{ marginTop: 20 }}
        >
          {t("invites.already_signed_in_continue")}
        </Button>
      </AuthCard>
    );
  }

  // They already run StingStream, so there is no account to create here — their own server says
  // who they are and this one makes the account off the back of that. Dan: "during the invite flow
  // offer the option to sign in with their own server or create an account".
  if (phase === "own-server") {
    return (
      <AuthCard>
        <SignInWithOwnServer
          nodeOrigin={nodeContext?.origin ?? ""}
          inviteToken={code}
          serverName={invite?.serverName}
          requestLink
          onCancel={() => setPhase("person")}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      {invite ? (
        <>
          <InviteAccountForm invite={invite} onSubmit={handleCreateAccount} />
          {/* Below the form, not beside it: creating an account is what almost everybody opening
              an invite is here to do, and this is the smaller door. */}
          <View
            style={{
              marginTop: 20,
              paddingTop: 16,
              borderTopWidth: 1,
              borderTopColor: color.border.subtle,
              gap: 8,
            }}
          >
            <Text variant='caption' tone='secondary'>
              {t("identity.join_own_server_prompt")}
            </Text>
            <Button
              testID='invite-use-own-server'
              variant='secondary'
              size='lg'
              onPress={() => setPhase("own-server")}
            >
              {t("identity.join_own_server_action")}
            </Button>
          </View>
        </>
      ) : null}
    </AuthCard>
  );
}
