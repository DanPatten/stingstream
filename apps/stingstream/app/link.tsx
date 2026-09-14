import { useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { AuthCard } from "@/components/login/AuthCard";
import { goToServer } from "@/components/stingstream/mesh/openOrCopy";
import { ShareLibrariesPicker } from "@/components/stingstream/mesh/ShareLibrariesPicker";
import { jellyfinUrlFor, useNodeContext } from "@/hooks/useNodeContext";
import { useTheme } from "@/hooks/useTheme";
import {
  useConnectToServer,
  useCreateConnectionInvite,
  useSaveConnectionRequest,
} from "@/lib/stingstream/connections";
import { apiAtom, useJellyfin, userAtom } from "@/providers/JellyfinProvider";
import { useMesh } from "@/providers/MeshProvider";
import { clearFragment, fragmentFromLocation } from "@/utils/identity/handoff";
import { resolveServerOrigin } from "@/utils/identity/resolveServer";
import { checkJellyfinServer } from "@/utils/jellyfin/checkServer";
import {
  buildInviteLink,
  type ConnectionInviteLink,
  type ConnectionStartLink,
  isInviteMaker,
  parseLink,
} from "@/utils/mesh/connectionLink";

/**
 * `/link` — where every link that connects two servers lands.
 *
 * Dan: *"one user does EVERYTHING once and they are done. The other user does everything once and
 * they are done - there isnt any more back and forth."* So this page never sends anybody to another
 * page to finish. What it shows depends on where it is standing and who is signed in:
 *
 * | Link | Page served by | Signed in as | Shows |
 * |---|---|---|---|
 * | invite | the server that made it | anyone | the reader's server address, then continues there |
 * | invite | another server | administrator | what this server shares, then Connect: done |
 * | invite | another server | member | saves a request for an administrator: done for them |
 * | start | the reader's own server | administrator | what this server shares, then back with an invite |
 * | start | the reader's own server | member | administrator access required |
 *
 * Nobody signed in on "another server" gets a sign-in form on this page first. The links themselves
 * are `utils/mesh/connectionLink.ts`.
 *
 * **Outside `(auth)`**, like `/join` and `/authorize`, and exempted by name in `useProtectedRoute`:
 * the reader may have no session here yet, and having one is no reason to bounce them to Home.
 */
export default function LinkPage() {
  const node = useNodeContext();
  const user = useAtomValue(userAtom);

  // During render, not in an effect: the fragment has to be read before anything can navigate.
  const [link] = useState(() => parseLink(fragmentFromLocation()));

  // The code admits a server to a connection, so it does not stay in the address bar or the
  // history. The page holds it in state from here on.
  useEffect(() => {
    if (link) clearFragment();
  }, [link]);

  // Which node this page is served by, which decides whether it is standing on the server that made
  // the invite. Asked of the side door, which answers anybody and says nothing more than its id.
  const [thisNode, setThisNode] = useState<string | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!node) {
      setThisNode(null);
      return;
    }
    let cancelled = false;
    fetch(`${node.origin}/sidedoor/v1/hello`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { node?: unknown } | null) => {
        if (!cancelled) {
          setThisNode(typeof body?.node === "string" ? body.node : null);
        }
      })
      .catch(() => {
        if (!cancelled) setThisNode(null);
      });
    return () => {
      cancelled = true;
    };
  }, [node]);

  if (!link) return <InvalidLink />;
  if (link.kind === "invite" && thisNode === undefined) return <Loading />;
  if (link.kind === "invite" && isInviteMaker(link.invite, thisNode)) {
    return <ServerAddressStep invite={link.invite} />;
  }
  if (!user?.Id) return <SignInStep />;

  const isAdmin = Boolean(user.Policy?.IsAdministrator);
  if (link.kind === "start") {
    return isAdmin ? <StartStep start={link.start} /> : <NotAdministrator />;
  }
  return isAdmin ? (
    <ConnectStep invite={link.invite} />
  ) : (
    <RequestStep invite={link.invite} />
  );
}

function Loading() {
  const { color } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: color.bg["0"],
      }}
    >
      <ActivityIndicator />
    </View>
  );
}

/** A title, a line, and one way out. */
function Notice({ title, detail }: { title: string; detail: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <AuthCard>
      <Text variant='title' weight='bold'>
        {title}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {detail}
      </Text>
      <Button
        variant='secondary'
        size='lg'
        onPress={() => router.replace("/")}
        style={{ marginTop: 20 }}
      >
        {t("sharing.link_done")}
      </Button>
    </AuthCard>
  );
}

function InvalidLink() {
  const { t } = useTranslation();
  return (
    <Notice
      title={t("sharing.link_invalid_title")}
      detail={t("sharing.link_invalid_detail")}
    />
  );
}

function NotAdministrator() {
  const { t } = useTranslation();
  return (
    <Notice
      title={t("sharing.link_not_admin_title")}
      detail={t("sharing.link_not_admin_detail")}
    />
  );
}

/** On the server that made the invite: where is yours? */
function ServerAddressStep({ invite }: { invite: ConnectionInviteLink }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const server = invite.server || t("sharing.server_untitled");

  const submit = async () => {
    const typed = address.trim();
    if (!typed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const found = await resolveServerOrigin(typed);
      const url = found
        ? buildInviteLink(found, { ...invite, forwarded: true })
        : null;
      if (!url) {
        setError(t("identity.own_server_not_found"));
        return;
      }
      await goToServer(url);
    } catch (e) {
      setError((e as Error)?.message || t("identity.own_server_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      <Text variant='title' weight='bold'>
        {t("sharing.link_to_title", { server })}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t("sharing.link_to_detail")}
      </Text>
      <View style={{ marginTop: 24, gap: 12 }}>
        <Input
          testID='link-server-address'
          aria-label={t("sharing.server_address")}
          placeholder={t("identity.own_server_placeholder")}
          value={address}
          onChangeText={setAddress}
          autoCapitalize='none'
          autoCorrect={false}
          autoComplete='off'
          keyboardType='url'
          returnKeyType='go'
          editable={!busy}
          onSubmitEditing={() => void submit()}
        />
        <FormError message={error} />
        <Button
          testID='link-server-address-continue'
          variant='primary'
          size='lg'
          loading={busy}
          disabled={busy || address.trim().length === 0}
          onPress={() => void submit()}
        >
          {t("sharing.continue")}
        </Button>
      </View>
    </AuthCard>
  );
}

/** Sign in on this page, so the link it is holding is not lost to a trip to `/login`. */
function SignInStep() {
  const { t } = useTranslation();
  const node = useNodeContext();
  const api = useAtomValue(apiAtom);
  const { login, setServer } = useJellyfin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!node || busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      // Pointed at this server before it can hold a session on it, the same step `/authorize` takes.
      if (!api?.basePath) {
        const found = await checkJellyfinServer(jellyfinUrlFor(node));
        if (!found) throw new Error(t("login.could_not_connect_to_server"));
        await setServer({ address: found.url });
      }
      await login(username.trim(), password);
    } catch (e) {
      setError((e as Error)?.message || t("identity.authorize_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      <Text variant='title' weight='bold'>
        {t("sharing.link_sign_in_title", {
          server: node?.serverName ?? t("sharing.server_untitled"),
        })}
      </Text>
      <View style={{ marginTop: 24, gap: 12 }}>
        <Input
          testID='link-username'
          aria-label={t("login.username_placeholder")}
          placeholder={t("login.username_placeholder")}
          value={username}
          onChangeText={setUsername}
          autoCapitalize='none'
          autoCorrect={false}
          autoComplete='username'
          textContentType='username'
          returnKeyType='next'
          editable={!busy}
        />
        <Input
          testID='link-password'
          aria-label={t("login.password_placeholder")}
          placeholder={t("login.password_placeholder")}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize='none'
          autoComplete='current-password'
          textContentType='password'
          returnKeyType='go'
          editable={!busy}
          onSubmitEditing={() => void submit()}
        />
      </View>
      <FormError message={error} />
      <Button
        testID='link-sign-in'
        variant='primary'
        size='lg'
        loading={busy}
        disabled={busy || !username.trim() || !password}
        onPress={() => void submit()}
        style={{ marginTop: 20 }}
      >
        {t("sharing.link_sign_in")}
      </Button>
    </AuthCard>
  );
}

/** Choose what this server shares, and press one button. */
function ShareStep({
  server,
  busy,
  error,
  onSubmit,
}: {
  server: string;
  busy: boolean;
  error: string | null;
  onSubmit: (libraries: string[] | null) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[] | null>(null);

  return (
    <AuthCard>
      <Text variant='title' weight='bold'>
        {t("sharing.connect_title", { server })}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t("sharing.share_detail", { server })}
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
        testID='link-connect'
        variant='primary'
        size='lg'
        loading={busy}
        disabled={busy}
        onPress={() => onSubmit(selected)}
        style={{ marginTop: 20 }}
      >
        {t("sharing.connect")}
      </Button>
    </AuthCard>
  );
}

/** An administrator here, holding another server's invite: connect. */
function ConnectStep({ invite }: { invite: ConnectionInviteLink }) {
  const { t } = useTranslation();
  const router = useRouter();
  const mesh = useMesh();
  const connect = useConnectToServer();
  const [error, setError] = useState<string | null>(null);
  const server = invite.server || t("sharing.server_untitled");

  const submit = async (libraries: string[] | null) => {
    setError(null);
    try {
      await connect.mutateAsync({ code: invite.code, libraries });
      await mesh.syncGroups();
      toast.success(t("sharing.connected", { server }));
      router.replace("/settings/servers");
    } catch (e) {
      setError((e as Error)?.message || t("sharing.connect_failed"));
    }
  };

  return (
    <ShareStep
      server={server}
      busy={connect.isPending}
      error={error}
      onSubmit={(libraries) => void submit(libraries)}
    />
  );
}

/** A member here, holding another server's invite: it waits for an administrator. */
function RequestStep({ invite }: { invite: ConnectionInviteLink }) {
  const { t } = useTranslation();
  const node = useNodeContext();
  const save = useSaveConnectionRequest();
  const [state, setState] = useState<"saving" | "sent" | "failed">("saving");
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);

  const mutate = save.mutateAsync;
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void mutate({
      code: invite.code,
      node: invite.node,
      serverName: invite.server,
    })
      .then(() => setState("sent"))
      .catch((e: Error) => {
        setError(e?.message || t("sharing.connect_failed"));
        setState("failed");
      });
  }, [invite, mutate, t]);

  if (state === "saving") return <Loading />;
  if (state === "failed") {
    return (
      <Notice title={t("sharing.link_invalid_title")} detail={error ?? ""} />
    );
  }
  return (
    <Notice
      title={t("sharing.request_sent_title")}
      detail={t("sharing.request_sent_detail", {
        server: node?.serverName ?? t("sharing.server_untitled"),
      })}
    />
  );
}

/**
 * An administrator on their own server, sent here by a server where they are only a member.
 *
 * This server makes the invite and the browser takes it back, where it becomes a request.
 */
function StartStep({ start }: { start: ConnectionStartLink }) {
  const { t } = useTranslation();
  const create = useCreateConnectionInvite();
  const [error, setError] = useState<string | null>(null);
  const server = start.server || t("sharing.server_untitled");

  const submit = async (libraries: string[] | null) => {
    setError(null);
    try {
      const invite = await create.mutateAsync(libraries);
      const url = buildInviteLink(start.returnTo, invite);
      if (!url) throw new Error(t("sharing.add_server_failed"));
      await goToServer(url);
    } catch (e) {
      setError((e as Error)?.message || t("sharing.add_server_failed"));
    }
  };

  return (
    <ShareStep
      server={server}
      busy={create.isPending}
      error={error}
      onSubmit={(libraries) => void submit(libraries)}
    />
  );
}
