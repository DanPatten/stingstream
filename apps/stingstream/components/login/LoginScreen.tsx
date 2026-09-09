import { useLocalSearchParams, useNavigation } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { QuickConnectCodeModal } from "@/components/login/QuickConnectCodeModal";
import { jellyfinUrlFor, useNodeContext } from "@/hooks/useNodeContext";
import { usePasskeySupport } from "@/hooks/usePasskeySupport";
import { useTheme } from "@/hooks/useTheme";
import {
  findLiveServer,
  readKnownServers,
} from "@/lib/stingstream/knownServers";
import { signInWithPasskey } from "@/lib/stingstream/passkeysApi";
import {
  createAdmin,
  getSetupState,
  SetupRequestError,
  type SetupState,
} from "@/lib/stingstream/setup";
import {
  apiAtom,
  pendingAccountSaveAtom,
  useJellyfin,
  userAtom,
} from "@/providers/JellyfinProvider";
import {
  checkJellyfinServer,
  NotAJellyfinServerError,
  ServerStartingError,
  ServerTooOldError,
} from "@/utils/jellyfin/checkServer";
import type { SavedServer } from "@/utils/secureCredentials";
import { AuthCard } from "./AuthCard";
import { ConnectScreen } from "./ConnectScreen";
import { decidePhase, type Phase } from "./loginPhase";
import { ServerStarting } from "./ServerStarting";
import { SetupAccountForm } from "./SetupAccountForm";
import { SetupElsewhere } from "./SetupElsewhere";
import { SignInForm } from "./SignInForm";
import { WelcomeScreen } from "./WelcomeScreen";

/**
 * How long to keep trying a node that is there but not ready, and how fast to back off.
 *
 * The budget is not a guess: `tools/ui-startup.ps1` allows the node **40 s** to become healthy
 * with the download managers off and **90 s** with them on, so a browser that gives up sooner is
 * giving up on a server that is doing exactly what it is supposed to. It used to allow 1.4 s
 * (three tries, 700 ms apart), which is how a cold node ended up showing an address form.
 *
 * The cap matches the `Retry-After: 5` the gateway sends with its own 503.
 */
const AUTO_CONNECT_BUDGET_MS = 90_000;
const AUTO_CONNECT_FIRST_DELAY_MS = 1_000;
const AUTO_CONNECT_MAX_DELAY_MS = 5_000;

/**
 * How many failed attempts before looking for a linked server instead.
 *
 * Two, which is about three seconds — long enough that a single dropped packet does not send
 * somebody to a different machine, short enough that a genuinely dead server does not cost the
 * full ninety. A server that answered with "still starting" never gets here at all: it is alive,
 * and waiting is the right answer.
 */
const FALLBACK_AFTER_ATTEMPTS = 2;

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
 *
 * **A node-served page never sees that step.** Not first, not as a fallback, not under Advanced:
 * the origin is the server. `decidePhase` in `./loginPhase.ts` is where that rule lives, with the
 * test that pins it.
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
    loginWithSavedCredential,
    loginWithPassword,
    initiateQuickConnect,
    stopQuickConnectPolling,
    adoptSession,
  } = useJellyfin();

  const params = useLocalSearchParams<{
    apiUrl?: string;
    username?: string;
    password?: string;
  }>();

  /**
   * Whether "which server?" is a question this platform can honestly ask.
   *
   * **Never on web.** A page was served by something, and that something is the server — so there
   * is nothing to ask and there must be nothing that can ask. It is not conditional on the marker:
   * making it conditional is exactly what shipped the address form twice, most recently because
   * the marker was being spliced into an HTML comment and every check for it failed.
   *
   * On a phone or a television it is a real question, and Dan's answer is that it stays:
   * *"url on phone/tv is fine"*.
   */
  const canAskForAddress = Platform.OS !== "web";

  const [phase, setPhase] = useState<Phase>(
    nodeContext || !canAskForAddress ? "connecting" : "serverForm",
  );
  /** Bumped by the Retry button, which is the only thing that re-runs the auto-connect. */
  const [connectAttempt, setConnectAttempt] = useState(0);
  /** True once the connect budget is spent, which turns the starting card into an offer to retry. */
  const [startingStalled, setStartingStalled] = useState(false);
  /** The linked server being tried, so the card can say where it is going rather than jump. */
  const [routingTo, setRoutingTo] = useState<string | null>(null);
  // Both halves have to say yes -- this browser, and a server with a domain to bind to. Null
  // while it is still being asked, so no link flashes and disappears.
  const passkeys = usePasskeySupport();
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
    async (url: string): Promise<string | null> => {
      const result = await checkJellyfinServer(url.trim().replace(/\/$/, ""));
      if (!result) throw new Error(t("login.could_not_connect_to_server"));
      await setServer({ address: result.url });
      return result.name || null;
    },
    [setServer, t],
  );

  /** The address form's Connect, with the three failures it can report worded for a person. */
  const handleConnect = useCallback(
    async (url: string) => {
      try {
        const name = await connectTo(url);
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
        if (e instanceof ServerStartingError) {
          // The address is right and the server said so itself. Blaming the address here is the
          // mistake this whole part exists to undo.
          throw new Error(t("login.server_starting_description"));
        }
        throw e;
      }
    },
    [connectTo, t],
  );

  // ---------------------------------------------------------------------------
  // Auto-connect + first-run decision
  // ---------------------------------------------------------------------------

  /**
   * Guards against a second run under React 19's development double-invoke.
   *
   * **Reset in the cleanup**, which is the whole point: StrictMode runs effect → cleanup → effect,
   * so a guard that is never cleared lets the second run bail while the first run's cleanup has
   * already cancelled it. Nothing then sets the phase and the card sits on "Connecting…" for ever.
   */
  const startedRef = useRef(false);

  // The callbacks the run below needs, held where a re-render cannot change their identity.
  //
  // `useJellyfin()` rebuilds its context value every render, so `connectTo` — which closes over
  // `setServer` — is a new function on every render. Listing it in the dependency array below
  // re-runs the effect on every render: the `startedRef` guard then makes each new run return
  // immediately while its own cleanup cancels the *one* run that was actually in flight, and the
  // card sits on "Connecting…" for ever. Observed, not theorised.
  const latest = useRef({ connectTo, t });
  latest.current = { connectTo, t };

  useEffect(() => {
    if (!nodeContext || startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    (async () => {
      const { connectTo, t } = latest.current;
      const target = jellyfinUrlFor(nodeContext);
      const deadline = Date.now() + AUTO_CONNECT_BUDGET_MS;

      // The connection is what makes whichever card lands able to do anything, so it is waited
      // for first; the setup query that follows is one cheap round trip against a node that has
      // just proved it answers.
      let name: string | null | undefined;
      let delay = AUTO_CONNECT_FIRST_DELAY_MS;
      let attempts = 0;
      // Set the moment the server says it is coming up, and never unset. It is the difference
      // between "wait" and "go somewhere else", and a node that has answered once is alive.
      let itIsAlive = false;
      for (;;) {
        try {
          name = await connectTo(target);
          break;
        } catch (e) {
          if (cancelled) return;
          attempts += 1;
          // A node serves its own web bundle from the gateway, which is listening well before the
          // Jellyfin behind it is. Say which of the two is happening rather than spinning
          // silently: "Starting your server" is true, and it is what somebody watching a fresh
          // install wants to be told.
          if (e instanceof ServerStartingError) {
            itIsAlive = true;
            setPhase("starting");
          }

          // Nothing answered, twice. Not "starting" — *absent*. Rather than ask for an address,
          // go to a server this one is linked to, which the app learned while it was working.
          // Dan: "the client should be smart… automatically routes to the first one that's up".
          if (!itIsAlive && attempts >= FALLBACK_AFTER_ATTEMPTS) {
            const live = await findLiveServer(readKnownServers(), {
              exceptOrigin: nodeContext.origin,
            });
            if (cancelled) return;
            if (live) {
              setRoutingTo(live.server.name || live.choice.url);
              setPhase("starting");
              // On web there is nothing to reuse: Jellyfin's CORS is deliberately closed, so the
              // winner has to serve its own bundle, its own marker and its own sign-in. That full
              // navigation *is* the mechanism, which is why a fresh login there is not a
              // compromise — Dan said so.
              if (Platform.OS === "web") {
                globalThis.location?.replace(live.choice.url);
              } else {
                await setServer({ address: `${live.choice.url}/jellyfin` });
                setServerName(live.server.name || null);
                setPhase("signIn");
              }
              return;
            }
          }

          if (Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, delay));
          if (cancelled) return;
          delay = Math.min(delay * 2, AUTO_CONNECT_MAX_DELAY_MS);
        }
      }
      if (cancelled) return;

      // The node's own name wins. Jellyfin's `ServerName` is the machine's hostname on a default
      // install — "Log in to PLEXPC" — and is never shown for a server we know is a node.
      if (!nodeContext.nodeName && name) setServerName(name);

      // Asked of the node itself, and allowed to come back with nothing: `decidePhase` treats
      // silence and a 404 the same way, by deferring to the marker.
      let state: SetupState | null = null;
      try {
        state = await getSetupState(nodeContext.origin);
      } catch {
        state = null;
      }
      if (cancelled) return;

      const decision = decidePhase({
        context: nodeContext,
        connected: name !== undefined,
        setup: state,
      });
      if (decision.unreachable) setSetupMessage(t("setup.error_unreachable"));
      // Reached only by running out of budget, since a successful connect leaves the loop above.
      if (decision.phase === "starting") setStartingStalled(true);
      setPhase(decision.phase);
    })();

    return () => {
      cancelled = true;
      startedRef.current = false;
    };
    // `nodeContext` never changes — it is read once at module scope. `connectAttempt` is the Retry
    // button. Everything else the run needs comes from `latest`, above.
  }, [nodeContext, connectAttempt]);

  /**
   * Deep link: `/login?apiUrl=…&username=…&password=…` still works on native, and still bypasses
   * all of the above.
   *
   * **Ignored on web**, where it is a second way to point the app at an address — it calls
   * `setServer` with no validation at all and forces the sign-in card, racing the auto-connect.
   * One rule, no exceptions: in a browser the origin is the server.
   */
  useEffect(() => {
    if (!params.apiUrl || !canAskForAddress) return;
    (async () => {
      await setServer({ address: params.apiUrl as string });
      setPhase("signIn");
    })();
  }, [params.apiUrl, canAskForAddress]);

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

  /**
   * A username and a password, checked by the server in front of you.
   *
   * It used to try a central account service first and fall back to here. There is no central
   * service any more (Part 5): a server holds its own accounts, and you get one because somebody
   * invited you to theirs. So this is the whole of signing in, and the error it reports is the one
   * the person can act on.
   */
  const handleSignIn = useCallback(
    async (username: string, password: string) => {
      await login(username, password, serverName ?? undefined);
      // The protection picker shows AFTER a successful login, from the root — this screen
      // unmounts the moment the session exists, so it cannot host the modal itself.
      if (keepSignedIn) {
        setPendingAccountSave({ serverName: serverName ?? undefined });
      }
    },
    [keepSignedIn, login, serverName, setPendingAccountSave],
  );

  /**
   * Sign in with a passkey, which takes nothing typed.
   *
   * The credential is discoverable, so the authenticator offers what it holds for this domain and
   * the server resolves the account from the user handle inside the assertion. A dismissed prompt
   * resolves to null and does nothing, because changing your mind is not a failure.
   *
   * The session is then established through the provider's own path rather than by adopting the
   * token this call returned -- the same reasoning first run and invite redemption use, and the
   * reason all three end up on Home the same way.
   */
  const handleSignInWithPasskey = useCallback(async () => {
    if (!nodeContext) throw new Error(t("passkeys.error_unavailable"));

    const result = await signInWithPasskey(nodeContext.origin);
    if (!result) return;

    if (!api?.basePath) {
      await connectTo(jellyfinUrlFor(nodeContext));
    }
    if (!result.accessToken || !result.userId) {
      throw new Error(t("passkeys.error_sign_in"));
    }
    adoptSession(result.accessToken, {
      Id: result.userId,
      Name: result.username,
    });
  }, [adoptSession, api?.basePath, connectTo, nodeContext, t]);

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
        // The welcome, not the form: somebody arriving here has read the "finish setup from a
        // device on your home network" card, not the one that says what StingStream is.
        setPhase("welcome");
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

  /**
   * Back to the address form, on the surfaces where there is an address to change.
   *
   * Passed to `SignInForm` only on a platform that can ask at all, and only when no node served
   * the page. In a browser it is never passed: the server is the origin, and offering to change it
   * offers to type back the address already in the URL bar.
   */
  const handleUseDifferentServer = useCallback(() => {
    removeServer();
    setServerName(null);
    setPhase("serverForm");
  }, [removeServer]);

  /** The starting card's Retry: run the whole auto-connect again from the top. */
  const handleRetryConnect = useCallback(() => {
    setStartingStalled(false);
    setPhase("connecting");
    setConnectAttempt((n) => n + 1);
  }, []);

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

        {phase === "starting" ? (
          <ServerStarting
            serverName={routingTo ?? serverName}
            routing={routingTo !== null}
            addresses={nodeContext?.addresses ?? []}
            exhausted={startingStalled}
            onRetry={handleRetryConnect}
          />
        ) : null}

        {phase === "welcome" ? (
          <WelcomeScreen onStart={() => setPhase("setup")} />
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
            keepSignedIn={keepSignedIn}
            onKeepSignedInChange={setKeepSignedIn}
            onSubmit={handleSignIn}
            onSignInWithCode={
              Platform.OS === "web" ? undefined : handleSignInWithCode
            }
            onUseDifferentServer={
              canAskForAddress && !nodeContext
                ? handleUseDifferentServer
                : undefined
            }
            onSignInWithPasskey={
              passkeys?.supported ? handleSignInWithPasskey : undefined
            }
          />
        ) : null}

        {phase === "serverForm" && canAskForAddress ? (
          <ConnectScreen
            initialUrl={params.apiUrl ?? ""}
            onConnect={handleConnect}
            onQuickLogin={loginWithSavedCredential}
            onPasswordLogin={loginWithPassword}
            onAddAccount={handleAddAccount}
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
