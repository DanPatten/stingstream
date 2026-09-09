import { useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, View } from "react-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { AuthCard } from "@/components/login/AuthCard";
import {
  InviteAccountForm,
  InviteLibraryList,
} from "@/components/stingstream/invites/InviteAccountForm";
import { tokens } from "@/constants/theme";
import { jellyfinUrlFor, useNodeContext } from "@/hooks/useNodeContext";
import {
  acceptInvite,
  type InviteDescription,
  InviteRequestError,
  lookupInvite,
} from "@/lib/stingstream/invitesApi";
import { apiAtom, useJellyfin, userAtom } from "@/providers/JellyfinProvider";
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
  const { t } = useTranslation();
  const router = useRouter();
  const nodeContext = useNodeContext();
  const { login, setServer } = useJellyfin();
  const user = useAtomValue(userAtom);
  const api = useAtomValue(apiAtom);

  // During render, not in an effect: a fragment has to be read before anything can navigate, and
  // an effect runs a beat too late on web. Harmless to call repeatedly -- it only remembers a
  // non-empty code, and the group path is the only thing that consumes it.
  const [code] = useState(() => inviteCodeFromLocation());

  const [phase, setPhase] = useState<
    "checking" | "person" | "group" | "signed-in" | "problem"
  >("checking");
  const [invite, setInvite] = useState<InviteDescription | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const decide = async () => {
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
        setPhase(user?.Id ? "signed-in" : "person");
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
        setPhase(user?.Id ? "signed-in" : "problem");
      }
    };

    void decide();
    return () => {
      cancelled = true;
    };
  }, [code, nodeContext, t, user?.Id]);

  // The group path leaves this screen entirely. Separate from the effect above so the navigation
  // happens after the phase has actually rendered -- replacing mid-decision races the router.
  useEffect(() => {
    if (phase === "group") router.replace("/settings/groups/join");
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
    },
    [api?.basePath, code, invite?.serverName, login, nodeContext, setServer, t],
  );

  if (phase === "checking" || phase === "group") {
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
        {invite ? <InviteLibraryList libraries={invite.libraries} /> : null}
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

  return (
    <AuthCard>
      {invite ? (
        <InviteAccountForm invite={invite} onSubmit={handleCreateAccount} />
      ) : null}
    </AuthCard>
  );
}
