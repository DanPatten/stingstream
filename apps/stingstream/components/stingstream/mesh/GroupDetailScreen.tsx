import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { PageContainer } from "@/components/common/PageContainer";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, space } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import {
  useConnectionDetails,
  useSetConnectionAddress,
} from "@/lib/stingstream/connections";
import {
  MeshUnavailableError,
  useLeaveMeshGroup,
  useNodeMeshGroups,
  useNodeMeshPeers,
  useNodeMeshStatus,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { SaveStatus, TextFieldRow } from "../settings/fields";
import { useAutosave } from "../settings/useAutosave";
import { confirmDestructive } from "../shared/confirm";
import { GapNotice } from "../shared/GapNotice";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { SharedLibrariesSection } from "./SharedLibraries";

/**
 * One connected server: its address, who connected it, what this server shares with it, and Remove.
 *
 * **Named after the other server**, not the group. A connection is one group per pair of servers,
 * and the group was named by whichever server made the invite, so on that server the group carries
 * its own name. The other member is what the reader is looking at.
 *
 * **No member list.** A connection is two servers, and listing both by name told the reader nothing
 * the title did not. Dan: *"dont show members - instead just show the user this is connected
 * through, dont list server names here"*.
 *
 * No rotate secret, no per-member removal, no invite button. Dan: *"lets remove the rotate secret
 * feature - we dont need that - just delete and re-add."*
 */
export function GroupDetailScreen({ group }: { group: string }) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(group);
  const status = useNodeMeshStatus();
  const leave = useLeaveMeshGroup();
  const mesh = useMesh();
  const isAdmin = useIsStingStreamAdmin();

  const info = useMemo(
    () => (groups.data ?? []).find((g) => g.group === group),
    [groups.data, group],
  );

  const me = status.data?.node?.toLowerCase();
  const other = (peers.data ?? []).find(
    (peer) => (peer.node ?? "").toLowerCase() !== me,
  );
  const server =
    other?.serverName || info?.name || t("sharing.server_untitled");

  const onRemove = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDestructive(
        t("sharing.remove_confirm_title", { server }),
        t("sharing.remove_confirm_detail"),
        t("sharing.remove_confirm_button"),
      );
      if (!confirmed) return;
      try {
        const removed = await leave.mutateAsync(group);
        // The embedded node follows the server, so tell it now rather than at the next sync.
        await mesh.syncGroups();
        toast.success(
          t(
            removed.pending.length > 0
              ? "sharing.removed_offline"
              : "sharing.removed",
            { server },
          ),
        );
        router.replace("/settings/servers");
      } catch (error) {
        toast.error((error as Error).message);
      }
    })();
  }, [group, leave, mesh, router, server, t]);

  // A server whose mesh child is down answers 503 here, which is "nothing can be asked right now",
  // not "this connection has no members".
  if (groups.error instanceof MeshUnavailableError) {
    return (
      <PageContainer width='settings'>
        <GapNotice
          title={t("sharing.mesh_unavailable_title")}
          detail={t("sharing.mesh_unavailable_detail")}
        />
      </PageContainer>
    );
  }

  // An id that is not one of this server's connections: a stale bookmark, or a path that happens to
  // match `[group]`. Gated on the query having answered, because in flight is "not known yet".
  if (groups.isSuccess && !info) {
    return (
      <PageContainer width='settings'>
        <EmptyState
          icon='servers'
          title={t("sharing.group_not_found_title")}
          detail={t("sharing.group_not_found_detail")}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer width='settings'>
      <QueryState
        isLoading={groups.isLoading}
        error={groups.error}
        onRetry={groups.refetch}
      >
        <View
          style={{
            padding: 16,
            borderRadius: radius.md,
            backgroundColor: color.bg["1"],
          }}
        >
          <Text variant='title' weight='semibold'>
            {server}
          </Text>
        </View>

        {isAdmin ? (
          <>
            <View style={{ height: 20 }} />
            <ConnectionSection group={group} />
            <View style={{ height: 20 }} />
            <SharedLibrariesSection group={group} />
            <View style={{ marginTop: 32 }}>
              <Button
                testID='sharing-remove-server'
                variant='danger'
                icon='delete'
                onPress={onRemove}
                loading={leave.isPending}
              >
                {t("sharing.remove_server")}
              </Button>
            </View>
          </>
        ) : null}
      </QueryState>
    </PageContainer>
  );
}

/**
 * Where the other server is reached, and who connected it.
 *
 * The address saves itself like every other settings field. Dan: *"allow the user to change the
 * domain in case the server moves"*.
 */
function ConnectionSection({ group }: { group: string }) {
  const { t } = useTranslation();
  const details = useConnectionDetails(group);
  const setAddress = useSetConnectionAddress(group);

  const { draft, set, saving } = useAutosave({
    value: details.data,
    save: async (next) => {
      try {
        await setAddress.mutateAsync(next.address?.trim() ?? "");
        toast.success(t("sharing.connection_saved"));
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : t("sharing.connection_save_failed"),
        );
      }
    },
  });

  if (!draft) return null;

  return (
    <View style={{ gap: space["2"] }}>
      <ListGroup>
        <TextFieldRow
          title={t("sharing.connection_address")}
          value={draft.address ?? ""}
          placeholder={t("sharing.connection_address_placeholder")}
          keyboardType='url'
          autoCapitalize='none'
          onChangeText={(v) => set((d) => ({ ...d, address: v }))}
        />
        {draft.connectedByName ? (
          <ListItem
            title={t("sharing.connected_by")}
            value={draft.connectedByName}
          />
        ) : null}
      </ListGroup>
      <SaveStatus saving={saving} />
    </View>
  );
}
