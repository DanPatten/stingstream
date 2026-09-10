import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { EmptyState } from "@/components/common/EmptyState";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { FocusTarget } from "@/components/settings/FocusTarget";
import { space, tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useLinkRequests } from "@/lib/stingstream/identity";
import {
  groupCounts,
  MeshUnavailableError,
  useNodeMeshGroups,
  useNodeMeshPeers,
} from "@/lib/stingstream/mesh";
import { MyServerScreen } from "../identity/MyServerScreen";
import { Disclosure } from "../shared/Disclosure";
import { GapNotice } from "../shared/GapNotice";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { QueryState } from "../shared/ScreenState";
import { LinkRequests } from "./LinkRequests";
import { SharingAddresses } from "./SharingAddresses";
import { ThisServerCard } from "./ThisServerCard";

/**
 * Every server question, on one page, in the order somebody reads them.
 *
 * ## What this page used to be
 *
 * Settings carried a "Sharing" group of three rows — *Servers*, *The server I run*, *This device* —
 * and the first of them opened a screen that tried to do everything at once. Dan's read of it, with
 * one request pending on screen: *"the servers page has so much fucking shit going on ... I cant
 * make anything out"*. Four faults, all answered here:
 *
 * 1. **An empty state over a page that was not empty.** "No servers linked" announced itself above
 *    a request plainly waiting for an answer. It renders only when there is nothing linked *and*
 *    nothing pending — see `LinkedServers`.
 * 2. **Three ways to start a link, none distinguishable.** "Link a server", "Join with a link" and
 *    "Invite a person instead", stacked. There is one path now: invite a **person** on Users &
 *    access; if they run a server they ask to link it from their own settings; an administrator
 *    approves it here. `LinkRequests` records what that cost and what replaced it.
 * 3. **Two filled buttons competing for the same decision.** Approve is the primary; Decline is a
 *    ghost.
 * 4. **This server's own identity at the bottom, inside "Advanced", under a heading that repeated
 *    itself.** It is the first card on the page now (`ThisServerCard`); Advanced keeps only the
 *    address settings it was always about.
 *
 * ## Why it is not administrator-gated, and what a member sees
 *
 * Every mesh call behind the linked-servers block needs elevation, which is why that block —
 * queries included — is only *mounted* for an administrator. A member never fires those requests
 * and so never sees a 403 over an empty list.
 *
 * What a member does get is the half that is theirs: **the server I run**, which is also the only
 * control anywhere that starts a link. Dan, when Servers first went behind the gate: *"make sure
 * that client users can still decide to share their server that they own in settings"*.
 */
export function ServersScreen({
  openAdvanced = false,
}: {
  openAdvanced?: boolean;
}) {
  const { t } = useTranslation();
  const isAdmin = useIsStingStreamAdmin();

  return (
    <View style={{ gap: space["6"] }}>
      <FocusTarget id='this-device'>
        <ThisServerCard />
      </FocusTarget>

      {isAdmin ? (
        <FocusTarget id='linked-servers'>
          <LinkedServers />
        </FocusTarget>
      ) : null}

      <FocusTarget id='my-server'>
        <MyServerBlock />
      </FocusTarget>

      {/* Last, and outside `LinkedServers`: this server's own addresses are what invite links are
          built from, so they have to be reachable — but putting them in front of somebody reading
          about links is what made three earlier versions of this unreadable. */}
      {isAdmin ? (
        <Disclosure title={t("sharing.advanced")} defaultOpen={openAdvanced}>
          <SharingAddresses />
        </Disclosure>
      ) : null}
    </View>
  );
}

/**
 * Requests waiting, then the servers already linked. Administrator-only, and *mounted* rather than
 * merely hidden — every query inside it is elevated.
 */
function LinkedServers() {
  const { t } = useTranslation();
  const router = useRouter();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(null);
  const requests = useLinkRequests();

  // A server whose mesh child is down answers 503, and that is emphatically not "you share with
  // nobody" — showing the empty state would tell the user their links had vanished. It gets its own
  // line, and this server's own card still renders above it.
  if (groups.error instanceof MeshUnavailableError) {
    return (
      <GapNotice
        title={t("sharing.mesh_unavailable_title")}
        detail={t("sharing.mesh_unavailable_detail")}
      />
    );
  }

  const servers = groups.data ?? [];
  const pending = (requests.data ?? []).filter((r) => r.status === "pending");

  return (
    <View style={{ gap: space["6"] }}>
      {/* Above the list, because a server waiting for an answer is a thing to do and the list is a
          thing to read. Draws nothing when nobody has asked. */}
      <LinkRequests />

      <QueryState
        isLoading={groups.isLoading}
        error={groups.error}
        onRetry={groups.refetch}
      >
        {servers.length > 0 ? (
          <ListGroup title={t("sharing.servers_title")}>
            {servers.map((group) => {
              const counts = groupCounts(peers.data, group.group);
              return (
                <ListItem
                  key={group.group}
                  testID='sharing-server'
                  title={group.name || t("sharing.server_untitled")}
                  subtitle={t("sharing.server_members", {
                    count: counts.members,
                    online: counts.online,
                  })}
                  showArrow
                  onPress={() =>
                    router.push(`/settings/servers/${group.group}`)
                  }
                  iconAfter={
                    <Icon
                      name='devices'
                      size={16}
                      color={
                        counts.online > 0
                          ? tokens.color.state.success
                          : tokens.color.text.tertiary
                      }
                    />
                  }
                />
              );
            })}
          </ListGroup>
        ) : pending.length === 0 ? (
          // Only when the page really is empty. With a request pending, "No servers linked" over
          // the top of it read as a screen confused about its own state.
          <EmptyState
            icon='servers'
            title={t("sharing.servers_empty_title")}
            detail={t("sharing.servers_empty_detail")}
          />
        ) : null}
      </QueryState>
    </View>
  );
}

/**
 * "The server I run", which used to be a settings row of its own.
 *
 * It keeps a heading, because the page changes subject here: everything above is about *this*
 * server, and this is about the reader's — and, since the link buttons went, it is also the only
 * control on the page that can start one.
 */
function MyServerBlock() {
  const { t } = useTranslation();

  return (
    <View>
      <Text
        variant='micro'
        weight='semibold'
        tone='tertiary'
        style={{
          marginLeft: 16,
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        {t("identity.my_server_title")}
      </Text>
      <MyServerScreen />
    </View>
  );
}
