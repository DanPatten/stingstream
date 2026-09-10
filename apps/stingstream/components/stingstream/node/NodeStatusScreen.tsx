import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Pill, type PillTone } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, tokens } from "@/constants/theme";
import {
  type NodeStatus,
  useMeshStatus,
  useNodeStatus,
} from "@/lib/stingstream/hooks";
import type { HealthzChild } from "@/lib/stingstream/status";
import { useHealthz } from "@/lib/stingstream/status";
import { GapNotice } from "../shared/GapNotice";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { QueryState } from "../shared/ScreenState";

/** "jellyfin"/"radarr"/"sonarr"/"nzbget"/"mesh" reach the UI verbatim from the
 * supervisor — data, not text this app wrote — and every one of those first
 * four is a name the brand rule bans from view. */
function childLabel(t: TFunction, name: string): string {
  switch (name) {
    case "jellyfin":
      return t("server_status.child_jellyfin");
    case "radarr":
      return t("server_status.child_radarr");
    case "sonarr":
      return t("server_status.child_sonarr");
    case "nzbget":
      return t("server_status.child_nzbget");
    case "mesh":
      return t("server_status.child_mesh");
    default:
      return name;
  }
}

/**
 * The build a child is running. Gap 10 closed.
 *
 * Two sources, on purpose. The supervisor probes each child as part of its own
 * health poll and puts the answer on `/healthz`, which is the one that keeps
 * working when Jellyfin itself is the child that is down. `NodeStatus` carries
 * the same numbers from Core, which is where the mesh's crate version comes from
 * and where the arrs' keys already live. Whichever answered is shown; the
 * supervisor wins a disagreement, because it is the process that launched the
 * binary.
 */
function versionOf(
  name: string,
  fromHealthz: string | null | undefined,
  status: NodeStatus | undefined,
): string {
  const fromCore = status?.Children?.[name]?.Version;
  return fromHealthz || fromCore || "—";
}

function childTone(child: HealthzChild): PillTone {
  if (!child.enabled) return "neutral";
  return child.state === "healthy" ? "success" : "danger";
}

function ChildCard({
  child,
  status,
}: {
  child: HealthzChild;
  status: NodeStatus | undefined;
}) {
  const { t } = useTranslation();
  return (
    <View
      style={{
        width: 180,
        borderRadius: radius.md,
        backgroundColor: tokens.color.bg["1"],
        padding: 12,
        marginRight: 12,
        marginBottom: 12,
      }}
    >
      <Text weight='semibold' numberOfLines={1}>
        {childLabel(t, child.name)}
      </Text>
      <Pill
        label={child.enabled ? child.state : t("server_status.child_disabled")}
        tone={childTone(child)}
        size='sm'
        style={{ marginTop: 8, alignSelf: "flex-start" }}
      />
      <Text variant='caption' tone='secondary' style={{ marginTop: 8 }}>
        {t("server_status.child_version", {
          version: versionOf(child.name, child.version, status),
        })}
      </Text>
      {child.port ? (
        <Text variant='caption' tone='secondary'>
          {t("server_status.child_port", { port: child.port })}
        </Text>
      ) : null}
      {child.restarts ? (
        <Text variant='micro' tone='tertiary' style={{ marginTop: 4 }}>
          {t("server_status.child_restarts", { count: child.restarts })}
        </Text>
      ) : null}
    </View>
  );
}

export function NodeStatusScreen() {
  const { t } = useTranslation();
  const healthz = useHealthz();
  const status = useNodeStatus();
  const mesh = useMeshStatus();

  return (
    <QueryState
      isLoading={healthz.isLoading}
      error={healthz.error}
      onRetry={healthz.refetch}
    >
      {healthz.data && (
        <>
          <ScreenHeaderRow title={t("server_status.server_section_title")} />
          <ListGroup>
            <ListItem
              title={t("server_status.name_field")}
              value={healthz.data.node.name}
            />
            <ListItem
              title={t("server_status.server_id_field")}
              value={healthz.data.node.id}
            />
            <ListItem
              title={t("server_status.mode_field")}
              value={
                healthz.data.node.dev
                  ? t("server_status.mode_dev")
                  : t("server_status.mode_installed")
              }
            />
            <ListItem
              title={t("server_status.data_dir_field")}
              value={healthz.data.node.data_dir}
            />
            <ListItem
              title={t("server_status.gateway_port_field")}
              value={String(healthz.data.gateway.port)}
            />
          </ListGroup>

          <View style={{ height: 16 }} />

          <ScreenHeaderRow title={t("server_status.children_section_title")} />
          {/*
            A node answering from off its own machine reports how many children
            it runs but not which, so there are no cards to draw. Saying that
            beats an empty row, which reads as a node running nothing.
          */}
          {healthz.data.redacted ? (
            <Text variant='caption' tone='secondary'>
              {t("server_status.children_redacted", {
                count: healthz.data.childCount,
              })}
            </Text>
          ) : (
            <View
              testID='server-status-cards'
              style={{ flexDirection: "row", flexWrap: "wrap" }}
            >
              {healthz.data.children.map((child) => (
                <ChildCard
                  key={child.name}
                  child={child}
                  status={status.data}
                />
              ))}
            </View>
          )}
          <Text variant='caption' tone='secondary' style={{ marginTop: -4 }}>
            {t("server_status.version_unknown_hint")}
          </Text>

          <View style={{ height: 16 }} />

          <ScreenHeaderRow title={t("server_status.core_section_title")} />
          {status.data && (
            <ListGroup>
              <ListItem
                title={t("server_status.first_run_field")}
                value={
                  status.data.FirstRun
                    ? t("server_status.yes")
                    : t("server_status.no")
                }
              />
              <ListItem
                title={t("server_status.inventory_records_field")}
                value={String(status.data.InventoryRecords)}
              />
              <ListItem
                title={t("server_status.hashing_queue_field")}
                value={String(status.data.Hashing?.Queued ?? 0)}
              />
              <ListItem
                title={t("server_status.core_database_field")}
                value={status.data.CoreDatabase ?? t("server_status.unknown")}
              />
            </ListGroup>
          )}

          <View style={{ height: 16 }} />

          <ScreenHeaderRow title={t("server_status.sharing_section_title")} />
          {mesh.data ? (
            <ListGroup>
              <ListItem
                title={t("server_status.server_id_field")}
                value={mesh.data.Node}
              />
              <ListItem
                title={t("server_status.version_field")}
                value={mesh.data.Version}
              />
              <ListItem
                title={t("server_status.groups_joined_field")}
                value={String(mesh.data.Groups ?? 0)}
              />
              <ListItem
                title={t("server_status.available_streams_field")}
                value={String(mesh.data.AvailableStreams ?? 0)}
              />
              <ListItem
                title={t("server_status.relay_field")}
                value={
                  mesh.data.RelayUrls?.join(", ") || t("server_status.none")
                }
              />
              <ListItem
                title={t("server_status.direct_addresses_field")}
                value={
                  mesh.data.DirectAddrs?.join(", ") || t("server_status.none")
                }
              />
            </ListGroup>
          ) : (
            <GapNotice
              title={t("server_status.mesh_unavailable_title")}
              detail={t("server_status.mesh_unavailable_detail")}
            />
          )}

          <View style={{ height: 16 }} />
        </>
      )}
    </QueryState>
  );
}
