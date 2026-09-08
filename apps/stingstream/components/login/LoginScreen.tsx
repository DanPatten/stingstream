import { useLocalSearchParams, useNavigation } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { QuickConnectCodeModal } from "@/components/login/QuickConnectCodeModal";
import {
  jellyfinUrlFor,
  type NodeContext,
  useNodeContext,
} from "@/hooks/useNodeContext";
import { useTheme } from "@/hooks/useTheme";
import {
  type AccountServer,
  DEFAULT_ACCOUNT_SERVICE,
  fetchMe,
  serverOrigin,
  signIn as signInToAccountService,
} from "@/lib/stingstream/accountsApi";
import {
  createAdmin,
  getSetupState,
  SetupRequestError,
} from "@/lib/stingstream/setup";
import {
  apiAtom,
  pendingAccountSaveAtom,
  useJellyfin,
  userAtom,
} from "@/providers/JellyfinProvider";
import {
  rememberAccountSession,
  takeAccountSession,
} from "@/utils/accounts/session";
import type { CustomHeader } from "@/utils/customHeaders";
import {
  checkJellyfinServer,
  NotAJellyfinServerError,
  ServerTooOldError,
} from "@/utils/jellyfin/checkServer";
import type { SavedServer } from "@/utils/secureCredentials";
import { AccountSignInForm } from "./AccountSignInForm";
import { AuthCard } from "./AuthCard";
import { ServerForm } from "./ServerForm";
import { SetupAccountForm } from "./SetupAccountForm";
import { SetupElsewhere } from "./SetupElsewhere";
import { SignInForm } from "./SignInForm";

/**
 * Which card the one pre-session screen is showing.
 *
 * Not routes. The whole flow lives at `/login` and always did; what changes is state, and making
 * it explicit is what stops the address form flashing in front of somebody whose server is the
 * page they are already looking at.
 */
type Phase =
  | "connecting"
  | "setup"
  | "setupElsewhere"
  | "signIn"
  | "account"
  | "serverForm";

/** How many times to retry the silent auto-connect before falling back to the address form. */
const AUTO_CONNECT_ATTEMPTS = 3;
const AUTO_CONNECT_RETRY_MS = 700;

/**
 * The golden path, and every path that is not it.
 *
 * Served by a node (the web build a node hands out, or a dev build pointed at one with
 * `EXPO_PUBLIC_STINGSTREAM_NODE_URL`): connect to that node silently, ask it whether it still
 * needs its first account, and show exactly one of "Create your StingStream account", "finish
 * setup on the computer running StingStream", or the sign-in card. No address step, ever.
 *
 * Anywhere else — a phone, a television, a bundle on a static host — the address step is the only
 * honest first question, so it is the first screen.
 */
export const LoginScreen: React.FC = () => {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const navigation = useNavigation();
  const nodeContext = useNodeContext();

  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const setPendingAccountSave = useSetAtom(pendingAccountSaveAtom);
  const {
    setServer,
    removeServer,
    login,
    loginWithAccountToken,
    loginWithSavedCredential,
    loginWithPassword,
    initiateQuickConnect,
    stopQuickConnectPolling,
  } = useJellyfin();

  const params = useLocalSearchParams<{
    apiUrl?: string;
    username?: string;
    password?: string;
  }>();

  // Not served by a node? Ask who you are, not where your server is. The address form is still
  // reachable from the account card, for somebody self-hosting an account service or opening a
  // machine no service has heard of — but it is no longer the first question anybody meets, which
  // is the whole of Dan's complaint about the join page.
  const [phase, setPhase] = useState<Phase>(
    nodeContext ? "connecting" : "account",
  );
  const [accountServers, setAccountServers] = useState<AccountServer[] | null>(
    null,
  );
  const [openingNode, setOpeningNode] = useState<string | null>(null);
  const [serverName, setServerName] = useState<string | null>(
    nodeContext?.nodeName ?? null,
  );
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [quickConnectCode, setQuickConnectCode] = useState<string | null>(null);
  const [quickConnectActive, setQuickConnectActive] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);

  // This screen owns no header. The card is the page: a navigation bar above it with a title and
  // a back chevron is the "cramped phone column" look, and there is nowhere to go back to.
  useEffect(() => {
    navigation.setOptions({ headerShown: false, title: t("login.sign_in") });
  }, [navigation, t]);

  useEffect(() => () => stopQuickConnectPolling(), [stopQuickConnectPolling]);

  // Close the code sheet as soon as the session exists, and flag the post-login save for a code
  // sign-in that asked for one (this screen unmounts on success, so the picker lives globally).
  useEffect(() => {
    if (!user) return;
    setQuickConnectCode(null);
    if (quickConnectActive && keepSignedIn) {
      setPendingAccountSave({ serverName: serverName ?? undefined });
    }
    setQuickConnectActive(false);
  }, [user]);

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  /**
   * Point the app at a server. The one path to `setServer` in this screen, deliberately —
   * `switchServerUrl` looks like the right call and is not: it no-ops before a session exists.
   */
  const connectTo = useCallback(
    async (url: string, headers?: CustomHeader[]): Promise<string | null> => {
      const result = await checkJellyfinServer(
        url.trim().replace(/\/$/, ""),
        headers,
      );
      if (!result) throw new Error(t("login.could_not_connect_to_server"));
      await setServer({ address: result.url });
      return result.name || null;
    },
    [loginWithAccountToken, setServer, t],
  );

  /** The address form's Connect, with the three failures it can report worded for a person. */
  const handleConnect = useCallback(
    async (url: string, headers?: CustomHeader[]) => {
      try {
        const name = await connectTo(url, headers);
        setServerName(name);
        setPhase("signIn");
      } catch (e) {
        if (e instanceof ServerTooOldError) {
          throw new Error(t("login.too_old_server_description"));
        }
        if (e instanceof NotAJellyfinServerError) {
          // Something answered — it just was not a StingStream server, at the root or under
          // /jellyfin. "Check your network connection" sends people to look at the wrong thing.
          throw new Error(t("login.not_a_jellyfin_server_description"));
        }
        throw e;
      }
    },
    [connectTo, t],
  );

  // ---------------------------------------------------------------------------
  // Auto-connect + first-run decision
  // ---------------------------------------------------------------------------

  /** Guards against a second run under React 19's development double-invoke. */
  const startedRef = useRef(false);

  /**
   * Which card a node should show, asked of the node itself.
   *
   * Returns rather than sets, so the caller can hold the "connecting" card until the connection
   * is ready too — a sign-in form rendered before `setServer` has landed accepts a password and
   * then fails with "API not initialized", which is a worse first impression than half a second
   * of a spinner.
   */
  const resolvePhase = useCallback(
    async (
      context: NodeContext,
      connected: boolean,
    ): Promise<{ phase: Phase; message?: string }> => {
      // Loopback or a private-network peer gets the account screen; anyone else is sent to
      // "finish it from a device on your home network" (Dan, 2026-09-07: "localhost only works
      // on the same PC — by IP is better"). Core's `setup/state` is the authority — it is the
      // same `SetupGate.IsTrustedPeer` check that actually gates `setup/admin`, run against the
      // real socket peer rather than a hostname string — so its answer wins whenever the request
      // succeeds; `context.trustedPeer` (client-derived from this page's own address) is only
      // the fallback for the one case Core cannot answer at all: unreachable.
      try {
        const state = await getSetupState(context.origin);
        if (!state.pending) {
          return { phase: connected ? "signIn" : "serverForm" };
        }
        return { phase: state.trustedPeer ? "setup" : "setupElsewhere" };
      } catch {
        // Nobody answered. The marker's hint is the only thing left, and it is better than
        // guessing: a pending node with an unreachable Core still must not offer a sign-in card
        // for an account that does not exist.
        if (context.setupPending === true) {
          return {
            phase: context.trustedPeer ? "setup" : "setupElsewhere",
            message: t("setup.error_unreachable"),
          };
        }
        return { phase: connected ? "signIn" : "serverForm" };
      }
    },
    [t],
  );

  // The two callbacks the run below needs, held where a re-render cannot change their identity.
  //
  // `useJellyfin()` rebuilds its context value every render, so `connectTo` — which closes over
  // `setServer` — is a new function on every render, and `resolvePhase` with it. Listing either
  // in the dependency array below re-runs the effect on every render: the `startedRef` guard then
  // makes each new run return immediately while its own cleanup cancels the *one* run that was
  // actually in flight, and the card sits on "Connecting…" for ever. Observed, not theorised.
  const latest = useRef({ connectTo, resolvePhase });
  latest.current = { connectTo, resolvePhase };

  useEffect(() => {
    if (!nodeContext || startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    (async () => {
      const { connectTo, resolvePhase } = latest.current;
      const target = jellyfinUrlFor(nodeContext);

      // The connection is what makes whichever card lands able to do anything, so it is waited
      // for first; the setup query that follows is one cheap round trip against a node that has
      // just proved it answers.
      const connecting = (async () => {
        for (let attempt = 1; attempt <= AUTO_CONNECT_ATTEMPTS; attempt++) {
          try {
            return await connectTo(target);
          } catch {
            // A node serves its own web bundle from the gateway, which is listening well before
            // Jellyfin behind it is. Retrying is the difference between the golden path and the
            // address form on a cold start.
            if (attempt < AUTO_CONNECT_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, AUTO_CONNECT_RETRY_MS));
            }
          }
        }
        return undefined;
      })();

      const name = await connecting;
      if (cancelled) return;

      // The node's own name wins. Jellyfin's `ServerName` is the machine's hostname on a default
      // install — "Log in to PLEXPC" — and is never shown for a server we know is a node.
      if (!nodeContext.nodeName && name) setServerName(name);

      const decision = await resolvePhase(nodeContext, name !== undefined);
      if (cancelled) return;
      if (decision.message) setSetupMessage(decision.message);
      setPhase(decision.phase);
    })();

    return () => {
      cancelled = true;
    };
    // `nodeContext` alone: it is read once at module scope and never changes. Everything else the
    // run needs comes from `latest`, above.
  }, [nodeContext]);

  /** Deep link: `/login?apiUrl=…&username=…&password=…` still works, and still bypasses all this. */
  useEffect(() => {
    if (!params.apiUrl) return;
    (async () => {
      await setServer({ address: params.apiUrl as string });
      setPhase("signIn");
    })();
  }, [params.apiUrl]);

  useEffect(() => {
    if (api?.basePath && params.apiUrl && params.username && params.password) {
      login(params.username, params.password).catch(() => {
        // The sign-in card is already on screen and will report it when they try by hand.
      });
    }
  }, [api?.basePath, params.apiUrl, params.username, params.password]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleSignIn = useCallback(
    async (username: string, password: string) => {
      await login(username, password, serverName ?? undefined);
      // The protection picker shows AFTER a successful login, from the root — this screen
      // unmounts the moment the session exists, so it cannot host the modal itself.
      if (keepSignedIn) {
        setPendingAccountSave({ serverName: serverName ?? undefined });
      }
    },
    [login, serverName, keepSignedIn, setPendingAccountSave],
  );

  const handleCreateAccount = useCallback(
    async (username: string, password: string) => {
      if (!nodeContext) throw new Error(t("setup.error_unexpected"));

      try {
        await createAdmin(nodeContext.origin, { username, password });
      } catch (e) {
        // Somebody claimed the node between this screen loading and this submit — a second
        // browser tab, or the machine's owner. Say so, and put them on the sign-in card rather
        // than leaving them on a form that can only fail from here on.
        //
        // `starting` is the opposite case and deliberately falls through to the form: the node is
        // still wiring itself up, `createAdmin` has already retried, and the honest thing is to
        // leave what they typed where it is with the reason under it and the button live again.
        if (e instanceof SetupRequestError && e.kind === "not_pending") {
          setPhase("signIn");
          toast.error(e.message);
          return;
        }
        throw e;
      }

      // Sign in with the credentials just chosen rather than adopting the token the endpoint
      // returned: the provider's own login path is what stores the session, refreshes plugin
      // settings and moves the app to Home, and it is the path every other sign-in takes.
      if (!api?.basePath) {
        await connectTo(jellyfinUrlFor(nodeContext));
      }
      await login(username, password, serverName ?? undefined);
    },
    [nodeContext, api?.basePath, connectTo, login, serverName, t],
  );

  const handleRetrySetup = useCallback(async () => {
    if (!nodeContext) return;
    setRetrying(true);
    setSetupMessage(null);
    try {
      const state = await getSetupState(nodeContext.origin, { attempts: 1 });
      if (!state.pending) {
        setPhase("signIn");
      } else if (state.trustedPeer) {
        setPhase("setup");
      } else {
        setSetupMessage(t("setup.elsewhere_still_pending"));
      }
    } catch (e) {
      setSetupMessage(
        e instanceof Error ? e.message : t("setup.error_unexpected"),
      );
    } finally {
      setRetrying(false);
    }
  }, [nodeContext, t]);

  const handleUseDifferentServer = useCallback(() => {
    removeServer();
    setServerName(null);
    setPhase("serverForm");
  }, [removeServer]);

  /** Back to the node's own sign-in card, reconnecting the server the user just cleared. */
  const handleCancelServerForm = useCallback(async () => {
    if (!nodeContext) return;
    setPhase("connecting");
    try {
      const name = await connectTo(jellyfinUrlFor(nodeContext));
      if (!nodeContext.nodeName && name) setServerName(name);
      setPhase("signIn");
    } catch {
      setPhase("serverForm");
    }
  }, [nodeContext, connectTo]);

  const handleSignInWithCode = useCallback(async () => {
    try {
      const code = await initiateQuickConnect();
      if (code) {
        setQuickConnectActive(true);
        setQuickConnectCode(code);
      }
    } catch {
      toast.error(t("login.failed_to_initiate_quick_connect"));
    }
  }, [initiateQuickConnect, t]);

  const handleAddAccount = useCallback(
    (server: SavedServer) => {
      setServer({ address: server.address });
      setServerName(server.name || null);
      setPhase("signIn");
    },
    [setServer],
  );

  // ---------------------------------------------------------------------------

  /**
   * Sign in to the account service, then decide what to do with the result.
   *
   * Two outcomes, and the good one is invisible: if this page is served by a node, the token is
   * spent on *that* node straight away and the person never sees a list. A list only appears when
   * there is a genuine choice to make.
   */
  const handleAccountSignIn = useCallback(
    async (username: string, password: string) => {
      const session = await signInToAccountService(
        DEFAULT_ACCOUNT_SERVICE,
        username,
        password,
      );
      rememberAccountSession(session.token);

      const me = await fetchMe(DEFAULT_ACCOUNT_SERVICE, session.token);

      const here = nodeContext?.origin;
      const thisOne = here
        ? me.servers.find((s) => serverOrigin(s) === here.replace(/\/+$/, ""))
        : undefined;
      if (here && thisOne) {
        await openServerWithAccount(thisOne, session.token);
        return;
      }
      // Exactly one reachable server is not a choice, so it is not offered as one.
      const reachable = me.servers.filter((s) => serverOrigin(s) !== null);
      if (reachable.length === 1) {
        await openServerWithAccount(reachable[0], session.token);
        return;
      }
      setAccountServers(me.servers);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeContext],
  );

  /**
   * Open one server with an account token.
   *
   * The exchange goes to the **server**, not to the account service: it verifies the token itself
   * against a key it cached when it was claimed. That is why this works with the account service
   * switched off, and it is the reason the whole design is signature-based.
   */
  const openServerWithAccount = useCallback(
    async (server: AccountServer, token: string) => {
      const origin = serverOrigin(server);
      if (!origin) throw new Error(t("account.server_no_address"));
      setOpeningNode(server.node);
      try {
        await setServer({ address: origin });
        await loginWithAccountToken(origin, token);
      } finally {
        setOpeningNode(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setServer, t],
  );

  return (
    <>
      <AuthCard>
        {phase === "connecting" ? (
          <View style={{ alignItems: "center", paddingVertical: 24 }}>
            <ActivityIndicator size='small' color={accent[500]} />
            <Text
              variant='body'
              tone='secondary'
              align='center'
              style={{ marginTop: 16 }}
            >
              {serverName
                ? t("login.connecting_to", { server: serverName })
                : t("login.connecting")}
            </Text>
          </View>
        ) : null}

        {phase === "setup" ? (
          <SetupAccountForm onSubmit={handleCreateAccount} />
        ) : null}

        {phase === "setupElsewhere" ? (
          <SetupElsewhere
            addresses={nodeContext?.addresses ?? []}
            onRetry={handleRetrySetup}
            retrying={retrying}
            message={setupMessage}
          />
        ) : null}

        {phase === "signIn" ? (
          <SignInForm
            serverName={serverName}
            servedByNode={nodeContext !== null}
            keepSignedIn={keepSignedIn}
            onKeepSignedInChange={setKeepSignedIn}
            onSubmit={handleSignIn}
            onSignInWithCode={
              Platform.OS === "web" ? undefined : handleSignInWithCode
            }
            onUseDifferentServer={handleUseDifferentServer}
          />
        ) : null}

        {phase === "account" ? (
          <AccountSignInForm
            onSubmit={handleAccountSignIn}
            servers={accountServers}
            busyNode={openingNode}
            onPickServer={(server) => {
              const token = takeAccountSession();
              if (token) void openServerWithAccount(server, token);
            }}
            onUseServerAddress={() => setPhase("serverForm")}
          />
        ) : null}

        {phase === "serverForm" ? (
          <ServerForm
            initialUrl={params.apiUrl ?? ""}
            onConnect={handleConnect}
            onQuickLogin={loginWithSavedCredential}
            onPasswordLogin={loginWithPassword}
            onAddAccount={handleAddAccount}
            onCancel={nodeContext ? handleCancelServerForm : undefined}
          />
        ) : null}
      </AuthCard>

      {/* Dismissing only hides the code — polling continues, so a code authorized afterwards still
          completes the sign-in. */}
      <QuickConnectCodeModal
        code={quickConnectCode}
        onClose={() => setQuickConnectCode(null)}
      />
    </>
  );
};
