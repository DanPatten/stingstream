import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
import { Icon } from "@/components/common/Icon";
import { PageContainer } from "@/components/common/PageContainer";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import {
  groupCounts,
  MeshUnavailableError,
  useNodeMeshGroups,
  useNodeMeshPeers,
} from "@/lib/stingstream/mesh";
import { Disclosure } from "../shared/Disclosure";
import { GapNotice } from "../shared/GapNotice";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { QueryState } from "../shared/ScreenState";
import { DeviceMeshSection } from "./DeviceMeshSection";
import { SharingAddresses } from "./SharingAddresses";

/**
 * The other people's servers this one is linked to.
 *
 * ## Why this is half of what the Sharing screen was
 *
 * Sharing answered two questions at once — who has an account here, and which servers this one
 * pools libraries with — and only the first of them has ever been something people go looking for.
 * With **Users** promoted to a section of its own, what is left is the server-to-server half, and
 * naming it after what it lists says more than "Sharing" did.
 *
 * The chooser went with it. Sharing's one button asked *"who are you inviting?"* because both
 * answers lived on the same screen; now the person half is on Users and the server half is here, so
 * each screen's button already knows.
 *
 * This server's own address is still folded away at the bottom rather than given a screen. It is
 * the thing invite links are built from, so it has to be reachable — but it arrives already set,
 * and putting it in front of somebody linking a server is what made three earlier versions of this
 * unreadable.
 */
export function ServersScreen({
  openAdvanced = false,
}: {
  openAdvanced?: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const isAdmin = useIsStingStreamAdmin();
  const groups = useNodeMeshGroups();
  const peers = useNodeMeshPeers(null);

  // A server whose mesh child is down answers 503, and that is emphatically not "you share with
  // nobody" — showing the empty state would tell the user their links had vanished. It gets its own
  // line, and this device's own status card still renders above it, because the phone's mesh is a
  // separate thing that may well be fine.
  if (groups.error instanceof MeshUnavailableError) {
    return (
      <PageContainer width='settings'>
        <DeviceMeshSection />
        <View style={{ height: 16 }} />
        <GapNotice
          title={t("sharing.mesh_unavailable_title")}
          detail={t("sharing.mesh_unavailable_detail")}
        />
      </PageContainer>
    );
  }

  const servers = groups.data ?? [];

  return (
    <PageContainer width='settings'>
      <DeviceMeshSection />
      <View style={{ height: 16 }} />

      <QueryState
        isLoading={groups.isLoading}
        error={groups.error}
        onRetry={groups.refetch}
      >
        {servers.length === 0 ? (
          <EmptyState
            icon='sharing'
            title={t("sharing.servers_empty_title")}
            detail={t("sharing.servers_empty_detail")}
          />
        ) : (
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
        )}
      </QueryState>

      <View style={{ height: 20 }} />

      {isAdmin ? (
        <View>
          <Button
            testID='sharing-create'
            variant='primary'
            size='lg'
            icon='add'
            onPress={() => router.push("/settings/servers/create")}
          >
            {t("sharing.create_group_button")}
          </Button>
          <View style={{ height: 8 }} />
          <Button
            testID='sharing-join'
            variant='secondary'
            icon='link'
            onPress={() => router.push("/settings/servers/join")}
          >
            {t("sharing.join_group_button")}
          </Button>
        </View>
      ) : (
        // A non-administrator sees the same list with no buttons and a reason, rather than buttons
        // that would answer 403. Linking servers is a decision about somebody's disk, their
        // bandwidth and their library.
        <Text variant='caption' tone='tertiary' align='center'>
          {t("sharing.admin_only_reason")}
        </Text>
      )}

      {isAdmin ? (
        <Disclosure title={t("sharing.advanced")} defaultOpen={openAdvanced}>
          <SharingAddresses />
        </Disclosure>
      ) : null}
    </PageContainer>
  );
}
