import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Pill, type PillTone } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
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

/** Child names reach the UI verbatim from the supervisor — data, not text this
 * app wrote — and most of them are names the brand rule bans from view. Each is
 * labelled by what it does for the reader, not by what it is. */
function childLabel(t: TFunction, name: string): string {
  switch (name) {
    case "jellyfin":
      return t("server_status.child_jellyfin");
    case "radarr":
      return t("server_status.child_radarr");
    case "sonarr":
      return t("server_status.child_sonarr");
    case "infinidysk":
      return t("server_status.child_infinidysk");
    case "mesh":
      return t("server_status.child_mesh");
    default:
      return t("server_status.child_other");
  }
}

/** `ChildState` in `mesh/crates/stingstream/src/state.rs`, snake_case on the
 * wire. An unrecognised state falls through to the raw word rather than
 * pretending to know it. */
function stateLabel(t: TFunction, state: string): string {
  switch (state) {
    case "healthy":
      return t("server_status.state_healthy");
    case "starting":
      return t("server_status.state_starting");
    case "unhealthy":
      return t("server_status.state_unhealthy");
    case "restarting":
      return t("server_status.state_restarting");
    case "stopped":
      return t("server_status.state_stopped");
    case "failed":
      return t("server_status.state_failed");
    default:
      return state;
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
 * binary. Neither answering is common while a child starts, and the line is
 * simply left off rather than explained.
 */
function versionOf(
  name: string,
  fromHealthz: string | null | undefined,
  status: NodeStatus | undefined,
): string | undefined {
  return fromHealthz || status?.Children?.[name]?.Version || undefined;
}

function childTone(child: HealthzChild): PillTone {
  if (child.state === "healthy") return "success";
  if (child.state === "starting" || child.state === "restarting")
    return "neutral";
  return "danger";
}

function ChildCard({
  child,
  status,
}: {
  child: HealthzChild;
  status: NodeStatus | undefined;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const version = versionOf(child.name, child.version, status);
  return (
    <View
      style={{
        width: 180,
        borderRadius: radius.md,
        backgroundColor: color.bg["1"],
        padding: 12,
        marginRight: 12,
        marginBottom: 12,
      }}
    >
      <Text weight='semibold' numberOfLines={1}>
        {childLabel(t, child.name)}
      </Text>
      <Pill
        label={stateLabel(t, child.state)}
        tone={childTone(child)}
        size='sm'
        style={{ marginTop: 8, marginBottom: 8, alignSelf: "flex-start" }}
      />
      {version ? (
        <Text variant='caption' tone='secondary'>
          {t("server_status.child_version", { version })}
        </Text>
      ) : null}
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
            {/* Both are held back from a reader who is not on the node's own machine, so the row
                goes rather than showing an empty one. A missing row reads as "not shown here";
                a row reading `undefined` reads as a bug. */}
            {healthz.data.node.data_dir && (
              <ListItem
                title={t("server_status.data_dir_field")}
                value={healthz.data.node.data_dir}
              />
            )}
            {healthz.data.gateway && (
              <ListItem
                title={t("server_status.gateway_port_field")}
                value={String(healthz.data.gateway.port)}
              />
            )}
          </ListGroup>

          <View style={{ height: 32 }} />

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
              {/* A disabled child is one this node was never asked to run, so
                  it is not a status worth reporting. Turning one on belongs to
                  the settings that need it, not to this screen. */}
              {healthz.data.children
                .filter((child) => child.enabled)
                .map((child) => (
                  <ChildCard
                    key={child.name}
                    child={child}
                    status={status.data}
                  />
                ))}
            </View>
          )}

          <View style={{ height: 32 }} />

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

          <View style={{ height: 32 }} />

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

          <View style={{ height: 32 }} />
        </>
      )}
    </QueryState>
  );
}
