import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FormError } from "@/components/common/FormError";
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
  type ConnectionRequestSummary,
  useApproveConnectionRequest,
  useConnectionRequests,
  useDeclineConnectionRequest,
  useReissueConnectionInvite,
} from "@/lib/stingstream/connections";
import {
  MeshUnavailableError,
  useLeaveMeshGroup,
  useNodeMeshGroups,
  useNodeMeshPeers,
  useNodeMeshStatus,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import {
  buildServerList,
  pendingInvitations,
  type ServerRow,
} from "@/utils/mesh/serverList";
import { ActionRow } from "../shared/ActionRow";
import { GapNotice } from "../shared/GapNotice";
import { IconAction } from "../shared/IconAction";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { InviteLinkDialog, useInviteLinkFor } from "./InviteLinkDialog";
import { openInNewTab } from "./openOrCopy";
import { ShareLibrariesPicker } from "./ShareLibrariesPicker";

export { AddServerButton } from "./AddServerWizard";

/**
 * Every server this one knows about, in one list.
 *
 * This server, the servers it is connected to, the connection requests waiting for an
 * administrator, and the invitations nobody has opened. Nothing else: no approval queue in its own
 * section, no "finish on your server" panel, no second list about a different machine. Dan, on the
 * version with all of those: *"its wayyy too overly complicated. I couldnt tell what was mine"*.
 *
 * Add server lives beside the pane's title (`AddServerWizard`).
 */
export function ServersScreen() {
  const { t } = useTranslation();
  const isAdmin = useIsStingStreamAdmin();
  const name = useServerName();
  const node = useNodeContext();
  const status = useNodeMeshStatus();
  const peers = useNodeMeshPeers(null);
  const groups = useNodeMeshGroups();
  const requests = useConnectionRequests();
  const [approving, setApproving] = useState<ConnectionRequestSummary | null>(
    null,
  );

  // `addresses` is what the gateway will tell a stranger; `origin` is only ever however *this*
  // page arrived, which on the node's own machine is `localhost` and means nothing to anybody else.
  const address = node?.addresses?.[0] ?? node?.origin ?? null;

  const rows = buildServerList(
    {
      node: status.data?.node ?? null,
      name: name ?? t("sharing.server_untitled"),
      address,
    },
    peers.data ?? [],
    isAdmin
      ? pendingInvitations(groups.data, peers.data, status.data?.node)
      : [],
    requests.data ?? [],
  );
  const others = rows.filter((row) => !row.isThisServer);

  return (
    <View style={{ gap: space["6"] }}>
      <FocusTarget id='linked-servers'>
        <View testID='sharing-servers'>
          <ListGroup>
            {rows.map((row) => (
              <ServerListRow key={row.key} row={row} onApprove={setApproving} />
            ))}
          </ListGroup>

          {/* A server whose mesh child is down answers 503, and that is emphatically not "you are
              connected to nobody". This server's own row still renders above the notice. */}
          {peers.error instanceof MeshUnavailableError ? (
            <View style={{ marginTop: space["4"] }}>
              <GapNotice
                title={t("sharing.mesh_unavailable_title")}
                detail={t("sharing.mesh_unavailable_detail")}
              />
            </View>
          ) : others.length === 0 && peers.isSuccess ? (
            <View style={{ marginTop: space["4"] }}>
              <EmptyState
                icon='servers'
                title={t("sharing.servers_empty_title")}
                detail={t("sharing.servers_empty_detail")}
              />
            </View>
          ) : null}
        </View>
      </FocusTarget>

      {approving ? (
        <ApproveDialog request={approving} onClose={() => setApproving(null)} />
      ) : null}
    </View>
  );
}

/**
 * One row. Press a connected server to manage it; the icon beside it opens that server.
 *
 * **The row is the settings and the icon is the door.** Dan: *"clicking the server opens the
 * settings page for it with a small link icon instead to the right to open it"*.
 */
function ServerListRow({
  row,
  onApprove,
}: {
  row: ServerRow;
  onApprove: (request: ConnectionRequestSummary) => void;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const isAdmin = useIsStingStreamAdmin();
  const leave = useLeaveMeshGroup();
  const decline = useDeclineConnectionRequest();
  const reissue = useReissueConnectionInvite();
  const linkFor = useInviteLinkFor();
  const [link, setLink] = useState<string | null>(null);

  if (row.pending === "invitation") {
    // The code itself is never stored, so pressing the row mints a fresh one for the same
    // connection. Dan: *"for pending invites on server list I should be able to click it to get
    // the invite link again"*.
    const showLink = () => {
      if (!row.group || reissue.isPending) return;
      reissue.mutate(row.group, {
        onSuccess: (invite) => {
          const url = linkFor(invite);
          if (url) setLink(url);
          else toast.error(t("sharing.add_server_failed"));
        },
        onError: (e) => toast.error(e.message),
      });
    };
    return (
      <>
        <ActionRow
          testID='sharing-invitation'
          title={t("sharing.invitation_pending")}
          subtitle={
            row.createdAt
              ? t("sharing.invitation_created", {
                  date: new Date(row.createdAt).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                  }),
                })
              : ""
          }
          leading={
            <Icon
              name='connectedServer'
              size={18}
              color={color.text.tertiary}
            />
          }
          onPress={showLink}
          actions={
            <IconAction
              testID='sharing-invitation-cancel'
              icon='close'
              tone='danger'
              label={t("sharing.invitation_cancel")}
              busy={leave.isPending}
              disabled={leave.isPending}
              onPress={() =>
                row.group &&
                leave.mutate(row.group, {
                  onSuccess: () =>
                    toast.success(t("sharing.invitation_cancelled")),
                  onError: (e) => toast.error(e.message),
                })
              }
            />
          }
        />
        {link ? (
          <InviteLinkDialog
            link={link}
            group={row.group}
            onClose={() => setLink(null)}
          />
        ) : null}
      </>
    );
  }

  if (row.pending === "request" && row.request) {
    const request = row.request;
    const server = row.name || t("sharing.server_untitled");
    return (
      <ActionRow
        testID='sharing-request'
        title={
          isAdmin ? t("sharing.request_wants_to_connect", { server }) : server
        }
        subtitle={
          isAdmin
            ? t("sharing.request_by", { name: request.requestedByName })
            : t("sharing.request_waiting")
        }
        leading={
          <Icon name='connectedServer' size={18} color={color.text.tertiary} />
        }
        onPress={() => (isAdmin ? onApprove(request) : undefined)}
        actions={
          <>
            {isAdmin ? (
              <IconAction
                testID='sharing-request-approve'
                icon='check'
                tone='success'
                label={t("sharing.request_approve")}
                onPress={() => onApprove(request)}
              />
            ) : null}
            <IconAction
              testID='sharing-request-decline'
              icon='close'
              tone='danger'
              label={
                isAdmin
                  ? t("sharing.request_decline")
                  : t("sharing.request_withdraw")
              }
              busy={decline.isPending}
              disabled={decline.isPending}
              onPress={() =>
                decline.mutate(request.id, {
                  onError: (e) => toast.error(e.message),
                })
              }
            />
          </>
        }
      />
    );
  }

  const press = () => {
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
          name={row.isThisServer ? "servers" : "connectedServer"}
          size={18}
          color={row.online ? color.state.success : color.text.tertiary}
        />
      }
      onPress={press}
      actions={
        <>
          {row.isThisServer ? (
            <Pill size='sm' tone='neutral' label={t("sharing.this_server")} />
          ) : null}
          {!row.isThisServer && row.address ? (
            <IconAction
              testID='sharing-server-open'
              icon='openExternal'
              label={t("sharing.server_open")}
              onPress={() => row.address && openInNewTab(row.address)}
            />
          ) : null}
        </>
      }
    />
  );
}

/** Approve a request: choose what this server shares, then connect. */
function ApproveDialog({
  request,
  onClose,
}: {
  request: ConnectionRequestSummary;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const approve = useApproveConnectionRequest();
  const mesh = useMesh();
  const [selected, setSelected] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const server = request.serverName || t("sharing.server_untitled");

  const submit = async () => {
    setError(null);
    try {
      await approve.mutateAsync({ id: request.id, libraries: selected });
      await mesh.syncGroups();
      toast.success(t("sharing.connected", { server }));
      onClose();
    } catch (e) {
      setError((e as Error)?.message || t("sharing.connect_failed"));
    }
  };

  return (
    <Dialog
      visible
      onClose={onClose}
      title={t("sharing.connect_title", { server })}
      description={t("sharing.share_detail", { server })}
    >
      <View style={{ gap: 12 }}>
        <ShareLibrariesPicker
          selected={selected}
          onChange={setSelected}
          disabled={approve.isPending}
        />
        <FormError message={error} />
        <Button
          testID='sharing-request-connect'
          variant='primary'
          size='lg'
          loading={approve.isPending}
          disabled={approve.isPending}
          onPress={() => void submit()}
        >
          {t("sharing.connect")}
        </Button>
      </View>
    </Dialog>
  );
}
