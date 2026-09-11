import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
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
import {
  useLinkRequests,
  useMyLinkRequest,
  useStartLinkRequest,
} from "@/lib/stingstream/identity";
import {
  MeshUnavailableError,
  useMintMeshInvite,
  useNodeMeshPeers,
  useNodeMeshStatus,
} from "@/lib/stingstream/mesh";
import type { MeshNodePeer } from "@/lib/stingstream/meshApi";
import {
  clearFragment,
  fragmentFromLocation,
  linkToFromLocation,
  parseAssertion,
  parseReturnLink,
} from "@/utils/identity/handoff";
import {
  buildServerList,
  type ServerRow,
  type WaitingServer,
} from "@/utils/mesh/serverList";
import { ActionRow } from "../shared/ActionRow";
import { GapNotice } from "../shared/GapNotice";
import { IconAction } from "../shared/IconAction";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { AddServerFinish, type FinishedLink } from "./AddServerFinish";
import { AddServerSheet } from "./AddServerSheet";
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
 * 4. *"The server I run - again confusing - remove it."*
 *
 * ## Why *Add server* is a button again
 *
 * It was `+ Add server` once, and became *Invite user* on Dan's word, because at the time the only
 * way a link could begin was to invite the **person** who ran the other server and wait for them
 * to sign in here with it. There was genuinely no server to add until somebody did.
 *
 * That is still the right flow for somebody you are introducing to the product, and it is kept.
 * It was never a flow for the two people this page now also serves. Dan: *"if you are already on a
 * server you may either own a 2nd server or you are an end user who has their own server. In this
 * case clicking Add Server starts the same workflow as invite: Start by asking for that other
 * server's address and complete the wizard, same as invite."* Neither of them has anybody to
 * invite, and before this neither could start anything from here at all.
 *
 * So the button is back, it says what it does, and **every member sees it**: an administrator's
 * own offer is approved as it is made, and a member's waits for one. `AddServerSheet` is the
 * wizard; `AddServerFinish` is what it ends in.
 *
 * ## What a member sees
 *
 * The list, with this server on it, their own offer if they have made one, and nothing else. Every
 * mesh call is elevated, so the peers query is only *mounted* for an administrator — a member
 * fires none of it and so never meets a 403 over an empty list.
 */
export function ServersScreen() {
  const isAdmin = useIsStingStreamAdmin();
  const { finished, adding } = useAddServerReturn();

  return (
    <View style={{ gap: space["6"] }}>
      {/* The answer to the wizard, above the list it is about to change. Drawn only for the
          browser that has just come back from the other server. */}
      {finished ? (
        <AddServerFinish link={finished} canChooseLibraries={isAdmin} />
      ) : null}

      <FocusTarget id='linked-servers'>
        {isAdmin ? <AllServers busy={adding} /> : <ServerList peers={[]} />}
      </FocusTarget>

      {isAdmin ? <LinkRequests /> : null}

      {/* Draws only for the person whose own server is waiting or was approved. */}
      <MyOffer hide={Boolean(finished)} />
    </View>
  );
}

/**
 * The return leg of the wizard: an assertion in the fragment, an address in the query string.
 *
 * **Read during render, not in an effect.** An effect runs after the router has had a chance to
 * navigate, and the fragment is gone by then — the same reason `/join` reads its own the same way.
 *
 * **Presented exactly once.** The nonce inside the assertion is spent by the first attempt, so a
 * second is refused; and this runs inside a screen whose queries invalidate on success, which
 * re-renders it. That is not a hypothetical — it is the bug `/join` already paid for, where the
 * second run replaced a sign-in that had worked with "this invite cannot be used". The ref is set
 * before the first `await` so two runs in one tick cannot both get past it.
 *
 * **And the credential in the fragment is ignored.** `/authorize` derives one whatever it is asked
 * for, and on this path the person already has a password on this server. Writing a derivation of
 * their *other* server's password over it would change how they sign in here as a side effect of
 * adding a server.
 */
function useAddServerReturn() {
  const { t } = useTranslation();
  const start = useStartLinkRequest();
  const [finished, setFinished] = useState<FinishedLink | null>(null);
  const presented = useRef(false);

  const [arrival] = useState(() => {
    const fragment = fragmentFromLocation();
    const assertion = parseAssertion(fragment);
    if (!assertion || !parseReturnLink(fragment)) return null;
    return { assertion, address: linkToFromLocation() };
  });

  // The fragment is read above, at mount; the request goes out here. Deliberately not in the
  // render body, and deliberately with no `cancelled` check on the way back: the nonce is spent
  // the moment the call returns, so there is no second attempt to fall back on, and this effect
  // does get torn down mid-flight when the mutation invalidates the queries this screen holds.
  const mutate = start.mutateAsync;
  useEffect(() => {
    if (!arrival || presented.current) return;
    presented.current = true;
    // Before the request goes out, not after it comes back. Nothing here outlives the attempt,
    // and leaving a spent assertion in the browser's history is leaving something that reads like
    // a credential lying about.
    clearFragment();
    void mutate({ assertion: arrival.assertion, address: arrival.address })
      .then((result) =>
        setFinished({
          status: result.status,
          issuerName: result.issuerName,
          issuerAddress: result.issuerAddress,
          groupId: result.groupId,
          code: result.code,
        }),
      )
      .catch((e: Error) =>
        // Reported rather than swallowed for the same reason the success is kept: this attempt was
        // the only one the nonce allowed, and a screen that silently looks unchanged is the worst
        // of the outcomes. Core writes every sentence this can fail with.
        toast.error(e?.message || t("sharing.add_server_failed")),
      )
      // **And again once everything has settled, which is the one that actually holds.** The
      // router parses the URL at mount and writes its own back, so a `replaceState` from the first
      // effect is undone a tick later and the fragment -- a spent assertion, and the salt and
      // verifier `/authorize` returns whatever it is asked for -- was still sitting in the address
      // bar and the history entry. Confirmed in a browser, which is the only place it is visible.
      //
      // Not a `router.replace` to the same path, which would be the tidier-looking fix: this
      // screen is holding the answer in state, and a route change is a chance to lose it.
      .finally(() => clearFragment());
  }, [arrival, mutate, t]);

  return { finished, adding: start.isPending };
}

/** The list, with the peers an administrator is allowed to ask about. */
function AllServers({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const peers = useNodeMeshPeers(null);

  // A server whose mesh child is down answers 503, and that is emphatically not "you are linked to
  // nobody" — showing an empty list would tell the reader their links had vanished. This server's
  // own row still renders above the notice.
  if (peers.error instanceof MeshUnavailableError) {
    return (
      <View style={{ gap: space["4"] }}>
        <ServerList peers={[]} busy={busy} />
        <GapNotice
          title={t("sharing.mesh_unavailable_title")}
          detail={t("sharing.mesh_unavailable_detail")}
        />
      </View>
    );
  }

  return <ServerList peers={peers.data ?? []} busy={busy} />;
}

/** One list of servers: this one, the ones it is linked to, and the ones on their way. */
function ServerList({
  peers,
  busy = false,
}: {
  peers: readonly MeshNodePeer[];
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const name = useServerName();
  const node = useNodeContext();
  const isAdmin = useIsStingStreamAdmin();
  // Only so this server cannot appear twice if the mesh ever lists it among its own peers. Not
  // worth a request of its own, which is why it rides on the status call the page already makes.
  const status = useNodeMeshStatus();
  const requests = useLinkRequests();
  const mine = useMyLinkRequest();

  // `addresses` is what the gateway will tell a stranger; `origin` is only ever however *this*
  // page arrived, which on the node's own machine is `localhost` and means nothing to anybody else.
  const address = node?.addresses?.[0] ?? node?.origin ?? null;

  // Whichever of the two lists this account can actually see. An administrator sees every offer;
  // a member sees only their own, and asks a different endpoint for it.
  const waiting: WaitingServer[] = isAdmin
    ? (requests.data ?? [])
        .filter((r) => r.status === "pending" || r.status === "approved")
        .map((r) => ({
          node: r.issuerNodeId,
          name: r.issuerName,
          address: r.issuerAddress,
          status: r.status === "approved" ? "approved" : "pending",
          group: r.groupId,
        }))
    : mine.data?.exists &&
        (mine.data.status === "pending" || mine.data.status === "approved")
      ? [
          {
            node: mine.data.issuerNodeId,
            name: t("sharing.my_server"),
            address: mine.data.issuerAddress,
            status: mine.data.status,
            group: null,
          },
        ]
      : [];

  const rows = buildServerList(
    {
      node: status.data?.node ?? null,
      name: name ?? t("sharing.server_untitled"),
      address,
    },
    peers,
    waiting,
  );

  const others = rows.filter((row) => !row.isThisServer);

  return (
    <View testID='sharing-servers'>
      {/* No heading of its own. The pane above already says *Servers*, over a page that is a list
          of them — Dan, seeing the word twice down the same column: *"why do I see servers listed
          twice like that"*. `Add server` sits beside the pane's title, which is where the Users
          screen puts `Invite` too. */}
      <ListGroup>
        {rows.map((row) => (
          <ServerListRow key={row.node} row={row} />
        ))}
      </ListGroup>

      {/* Only when this server really does stand alone. A server plainly on its way in is listed
          just above, and "No servers linked" over the top of it is the fault this page was rebuilt
          to remove — a screen confused about its own state. */}
      {isAdmin && others.length === 0 && !busy ? (
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
 *
 * **A server still being added manages nothing**, because there is nothing there yet to manage.
 * Pressing one that is waiting for the other side offers the link again instead, which is the only
 * thing anybody wants from that row.
 */
function ServerListRow({ row }: { row: ServerRow }) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const [offering, setOffering] = useState(false);

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

  const press = () => {
    if (row.waiting === "them") {
      setOffering(true);
      return;
    }
    if (row.waiting) return;
    if (row.isThisServer) {
      router.push("/settings/servers/this");
      return;
    }
    if (row.group) router.push(`/settings/servers/${row.group}`);
  };

  const subtitle = row.waiting
    ? row.waiting === "approval"
      ? t("sharing.waiting_for_approval")
      : t("sharing.waiting_for_them")
    : (row.address ?? t("sharing.server_no_address"));

  return (
    <>
      <ActionRow
        testID='sharing-server'
        title={row.name}
        subtitle={subtitle}
        leading={
          <Icon
            name='servers'
            size={18}
            color={
              row.waiting
                ? color.text.tertiary
                : row.online
                  ? color.state.success
                  : color.text.tertiary
            }
          />
        }
        onPress={press}
        actions={
          <>
            {row.isThisServer ? (
              <Pill size='sm' tone='neutral' label={t("sharing.this_server")} />
            ) : null}
            {row.waiting === "them" ? (
              <Pill size='sm' tone='accent' label={t("sharing.waiting_pill")} />
            ) : null}
            {!row.isThisServer && !row.waiting && row.address ? (
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

      {offering && row.group ? (
        <OfferAgainDialog
          group={row.group}
          name={row.name}
          address={row.address}
          onClose={() => setOffering(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The link again, for a server that has been approved here and has not accepted yet.
 *
 * **A fresh invite, not the one from before.** The code an approval minted is a credential, and
 * the administrator's list deliberately does not carry it — looking at the queue does not need it.
 * Minting another is one call, costs nothing while it is unspent, and means this screen never has
 * to be handed a credential in order to draw a list.
 */
function OfferAgainDialog({
  group,
  name,
  address,
  onClose,
}: {
  group: string;
  name: string;
  address: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const mint = useMintMeshInvite();
  const [link, setLink] = useState<FinishedLink | null>(null);
  const asked = useRef(false);

  // Once, however often this re-renders: minting is not idempotent, and every unspent code is one
  // more string that admits a server to this link.
  const mutate = mint.mutateAsync;
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void mutate(group)
      .then((invite) =>
        setLink({
          status: "approved",
          issuerName: name,
          issuerAddress: address,
          groupId: group,
          code: invite.code,
        }),
      )
      .catch((e: Error) => {
        toast.error(e?.message || t("sharing.invite_mint_failed_title"));
        onClose();
      });
  }, [address, group, mutate, name, onClose, t]);

  return (
    <Dialog
      visible
      onClose={onClose}
      title={t("sharing.add_server_ready_title", { server: name })}
    >
      {link ? (
        <AddServerFinish link={link} canChooseLibraries />
      ) : (
        <View style={{ padding: space["4"] }} />
      )}
    </Dialog>
  );
}

/**
 * *Add server*, beside the pane's title.
 *
 * Every member, because the question it asks is one a member can answer: *do you run a server?* The
 * decision it leads to is still an administrator's, and that split is the whole of what keeps
 * `docs/INVITES.md` §3's first row true — holding an account on somebody's server does not let you
 * decide anything about it.
 */
export function AddServerButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        testID='sharing-add-server'
        variant='primary'
        size='sm'
        icon='add'
        onPress={() => setOpen(true)}
      >
        {t("sharing.add_server")}
      </Button>
      <AddServerSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * The link that finishes it, for the person whose own server is waiting or was approved.
 *
 * **This is the one piece of "the server I run" that had to survive.** Approving mints an ordinary
 * group invite and hands it back to whoever asked; they finish on their *own* server, because
 * choosing what that server shares back is their decision and not this one's. Without somewhere to
 * find the link, an approval went nowhere and the link could never complete.
 *
 * What went with the rest of that block is everything around it: a node id, a status list, a "you
 * do not run a server here" empty state for the overwhelming majority who do not. This draws only
 * for the account it is about, and it is one panel.
 *
 * Hidden while the wizard's own answer is on screen, which says the same thing about the same
 * server a moment more freshly.
 *
 * **And hidden once the link is actually made.** An approval is not the end of anything: the code
 * stands until somebody redeems it, so the server goes on reporting one long after the other side
 * has accepted. Left alone, "Finish linking your server" sat above a list with that very server
 * on it as a working peer — a screen telling somebody to do a thing they had already done. The
 * peer list is what settles it; a member cannot see one, and a member is not the person who can
 * have finished it behind this screen's back.
 */
function MyOffer({ hide }: { hide: boolean }) {
  const { t } = useTranslation();
  const mine = useMyLinkRequest();
  // The same key the list above already asked for, so this costs no request. Undefined for a
  // member, whose query never runs, which is the reading that keeps their panel drawn.
  const peers = useNodeMeshPeers(null);

  if (hide || !mine.data?.exists) return null;
  if (mine.data.status !== "approved" && mine.data.status !== "pending") {
    return null;
  }

  const theirs = mine.data.issuerNodeId.toLowerCase();
  const linked = (peers.data ?? []).some(
    (peer) => (peer.node ?? "").toLowerCase() === theirs,
  );
  if (linked) return null;

  return (
    <View testID='sharing-my-offer'>
      <AddServerFinish
        mine
        link={{
          status: mine.data.status,
          // Not `serverName`, which is *this* server -- the sentence it was added for was about
          // who is being asked. The row is about the server the reader runs, and this page has
          // never been told what they call it.
          issuerName: t("sharing.my_server"),
          issuerAddress: mine.data.issuerAddress,
          groupId: null,
          code: mine.data.code,
        }}
      />
    </View>
  );
}
