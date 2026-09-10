import { useTranslation } from "react-i18next";
import { Linking, Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
import { Icon } from "@/components/common/Icon";
import { Pill } from "@/components/common/Pill";
import { ListGroup } from "@/components/list/ListGroup";
import { FocusTarget } from "@/components/settings/FocusTarget";
import { space } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useNodeContext } from "@/hooks/useNodeContext";
import { useServerName } from "@/hooks/useServerName";
import { useTheme } from "@/hooks/useTheme";
import { useLinkRequests, useMyLinkRequest } from "@/lib/stingstream/identity";
import {
  MeshUnavailableError,
  useNodeMeshPeers,
  useNodeMeshStatus,
} from "@/lib/stingstream/mesh";
import type { MeshNodePeer } from "@/lib/stingstream/meshApi";
import { buildServerList, type ServerRow } from "@/utils/mesh/serverList";
import { ActionRow } from "../shared/ActionRow";
import { GapNotice } from "../shared/GapNotice";
import { IconAction } from "../shared/IconAction";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { LinkRequests } from "./LinkRequests";

/**
 * Every server this one knows about, in one list.
 *
 * ## What this page used to be
 *
 * A *THIS SERVER* card with the address folded inside it as a sub-row, a separate list of linked
 * servers below, a *REQUESTS TO LINK* block answered by two competing buttons, and a *THE SERVER I
 * RUN* section at the bottom about a different machine entirely. Dan: *"this is still too
 * confusing"*, and then, item by item:
 *
 * 1. *"dont show address as a sub-thing, dont say THis server - just list ALL servers with this
 *    server labeled - address listed. Clicking it takes you to that server address directly."*
 *    One list, `buildServerList`. This server is a row in it, marked with a pill rather than
 *    sectioned off, and the address is the subtitle rather than something you open a row to find.
 * 2. *"approve/decline should just be inline icons with hover text"* — `LinkRequests`.
 * 3. *"whole server label on Servers is confusing - remove that"* — the pane's scope badge, gone
 *    in `ServersPane`.
 * 4. *"The server I run - again confusing - remove it."* Nothing is lost by it: signing in with
 *    your own server submits the link request by itself, so that block was a second way to ask a
 *    question already asked. `docs/INVITES.md` §11.
 * 5. *"Add a simple Add server button to link another server - must be done through a user"* —
 *    `InviteUserButton`, which goes to the one place a link can start. It says *Invite user*
 *    rather than *Add server* on Dan's word, because inviting the person is literally the act:
 *    there is no server to add until somebody signs in with theirs.
 *
 * ## What a member sees
 *
 * The list, with this server on it, and nothing else. Every mesh call is elevated, so the peers
 * query is only *mounted* for an administrator — a member fires none of it and so never meets a
 * 403 over an empty list.
 */
export function ServersScreen() {
  const isAdmin = useIsStingStreamAdmin();

  return (
    <View style={{ gap: space["6"] }}>
      <FocusTarget id='linked-servers'>
        {isAdmin ? <AllServers /> : <ServerList peers={[]} />}
      </FocusTarget>

      {isAdmin ? <LinkRequests /> : null}

      {/* Draws only for the person whose own server was approved, which is rarely the reader. */}
      <LinkApproved />
    </View>
  );
}

/** The list, with the peers an administrator is allowed to ask about. */
function AllServers() {
  const { t } = useTranslation();
  const peers = useNodeMeshPeers(null);

  // A server whose mesh child is down answers 503, and that is emphatically not "you are linked to
  // nobody" — showing an empty list would tell the reader their links had vanished. This server's
  // own row still renders above the notice.
  if (peers.error instanceof MeshUnavailableError) {
    return (
      <View style={{ gap: space["4"] }}>
        <ServerList peers={[]} />
        <GapNotice
          title={t("sharing.mesh_unavailable_title")}
          detail={t("sharing.mesh_unavailable_detail")}
        />
      </View>
    );
  }

  return <ServerList peers={peers.data ?? []} />;
}

/** One list of servers: this one, then the ones it is linked to. */
function ServerList({ peers }: { peers: readonly MeshNodePeer[] }) {
  const { t } = useTranslation();
  const name = useServerName();
  const node = useNodeContext();
  const isAdmin = useIsStingStreamAdmin();
  // Only so this server cannot appear twice if the mesh ever lists it among its own peers. Not
  // worth a request of its own, which is why it rides on the status call the page already makes.
  const status = useNodeMeshStatus();
  const requests = useLinkRequests();

  // `addresses` is what the gateway will tell a stranger; `origin` is only ever however *this*
  // page arrived, which on the node's own machine is `localhost` and means nothing to anybody else.
  const address = node?.addresses?.[0] ?? node?.origin ?? null;

  const rows = buildServerList(
    {
      node: status.data?.node ?? null,
      name: name ?? t("sharing.server_untitled"),
      address,
    },
    peers,
  );

  const linked = rows.filter((row) => !row.isThisServer);
  // Read here rather than left to `LinkRequests` below, which only knows whether to draw itself.
  const pending = (requests.data ?? []).filter((r) => r.status === "pending");

  return (
    <View testID='sharing-servers'>
      {/* No heading of its own. The pane above already says *Servers*, over a page that is a list
          of them — Dan, seeing the word twice down the same column: *"why do I see servers listed
          twice like that"*. `Invite user` moved up beside the pane's title, which is where the
          Users screen puts `Invite` too. */}
      <ListGroup>
        {rows.map((row) => (
          <ServerListRow key={row.node} row={row} />
        ))}
      </ListGroup>

      {/* Only when this server really does stand alone. A server is plainly waiting for an answer
          just below, and "No servers linked" over the top of it is the fault this page was rebuilt
          to remove — a screen confused about its own state. */}
      {isAdmin && linked.length === 0 && pending.length === 0 ? (
        <View style={{ marginTop: space["4"] }}>
          <EmptyState
            icon='servers'
            title={t("sharing.servers_empty_title")}
            detail={t("sharing.servers_empty_detail")}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * One server: press it to manage it, or use the link beside it to go there.
 *
 * **The row is the settings and the icon is the door**, which is the reverse of how this started.
 * Dan: *"clicking the server opens the settings page for it with a small link icon instead to the
 * right to open it (reverse of what we have)"*. It is the right way round — a row in a settings
 * list should do what the rest of the settings list does, and leaving the app entirely is the
 * unusual act that deserves its own small control.
 *
 * **This server's row goes to its own settings page**, which is where its name is changed — Dan:
 * *"change Servers -> This server to link to its own settings page where you can change the server
 * name"*. It went to the home dashboard before that, which made the one server whose settings the
 * reader certainly holds the only row on the page that managed nothing.
 *
 * It still has no link of its own: "open this server" is the app you are already standing in, and
 * two controls with one destination is the redundancy this page keeps shedding.
 */
function ServerListRow({ row }: { row: ServerRow }) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const open = () => {
    if (!row.address) return;
    if (Platform.OS === "web") {
      // A different origin, so a real navigation rather than a router push. A new tab, because
      // leaving the page somebody is administering to look at another server is not what pressing
      // a control in a list should cost them.
      (globalThis as { open?: (u: string, target?: string) => void }).open?.(
        row.address,
        "_blank",
      );
      return;
    }
    void Linking.openURL(row.address);
  };

  const manage = () => {
    if (row.isThisServer) {
      router.push("/settings/servers/this");
      return;
    }
    if (row.group) router.push(`/settings/servers/${row.group}`);
  };

  return (
    <ActionRow
      testID='sharing-server'
      title={row.name}
      subtitle={row.address ?? t("sharing.server_no_address")}
      leading={
        <Icon
          name='servers'
          size={18}
          color={row.online ? color.state.success : color.text.tertiary}
        />
      }
      onPress={manage}
      actions={
        <>
          {row.isThisServer ? (
            <Pill size='sm' tone='neutral' label={t("sharing.this_server")} />
          ) : null}
          {!row.isThisServer && row.address ? (
            <IconAction
              testID='sharing-server-open'
              // A box with an arrow leaving it, not a chain link: this is the one control on the
              // page that takes you out of the app, and it opens a new window to do it. A chain
              // said "there is a link here" when what mattered was where pressing it lands you.
              icon='openExternal'
              label={t("sharing.server_open")}
              onPress={open}
            />
          ) : null}
        </>
      }
    />
  );
}

/**
 * The one way to add a server: invite the person who runs it.
 *
 * Dan: *"Add a simple Add server button to link another server - must be done through a user"*,
 * and then *"instead of '+ Add server' change to Invite user"*. It is a link to Users & access
 * rather than a form, because that is literally where the act happens: you invite the **person**
 * who runs the other server, they sign in here with it, and the ask arrives above. There is no
 * address to type and no code to paste — `docs/INVITES.md` §11 has why that is the only shape this
 * can take, and it is why the button now says what it actually does rather than promising a form
 * that adds a server.
 */
export function InviteUserButton() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <Button
      testID='sharing-invite-user'
      variant='primary'
      size='sm'
      icon='invite'
      onPress={() => router.push("/settings/users")}
    >
      {t("sharing.invite_user")}
    </Button>
  );
}

/**
 * The code that finishes a link, for the person whose server was approved.
 *
 * **This is the one piece of "the server I run" that had to survive.** Approving mints an ordinary
 * group invite and hands it back to whoever asked; they redeem it on their *own* server, because
 * choosing what that server shares back is their decision and not this one's — `docs/INVITES.md`
 * §11. Without somewhere to read the code, an approval went nowhere and the link could never
 * complete.
 *
 * What went with the rest of that block is everything around it: a node id, a status list, a
 * "you do not run a server here" empty state for the overwhelming majority who do not. This draws
 * only for the account it is about, only once its request has been approved, and it is one row.
 */
function LinkApproved() {
  const { color } = useTheme();
  const { t } = useTranslation();
  const mine = useMyLinkRequest();

  const code = mine.data?.status === "approved" ? mine.data.code : null;
  if (!code) return null;

  const copy = async () => {
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(code);
        toast.success(t("sharing.link_approved_copied"));
      } catch {
        toast.error(t("invites.copy_failed"));
      }
      return;
    }
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(code);
    toast.success(t("sharing.link_approved_copied"));
  };

  return (
    <View testID='sharing-link-approved'>
      <ListGroup title={t("sharing.link_approved_title")}>
        <ActionRow
          testID='sharing-link-approved-row'
          title={code}
          subtitle={t("sharing.link_approved_detail")}
          leading={<Icon name='link' size={18} color={color.text.tertiary} />}
          onPress={() => void copy()}
          actions={
            <IconAction
              testID='sharing-link-approved-copy'
              icon='share'
              label={t("invites.copy")}
              onPress={() => void copy()}
            />
          }
        />
      </ListGroup>
    </View>
  );
}
