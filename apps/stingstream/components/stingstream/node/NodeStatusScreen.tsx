import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import {
  type NodeStatus,
  useMeshStatus,
  useNodeStatus,
} from "@/lib/stingstream/hooks";
import { useHealthz } from "@/lib/stingstream/status";
import { GapNotice } from "../shared/GapNotice";
import { QueryState } from "../shared/ScreenState";
import { SideDoorSection } from "./SideDoorSection";

function stateColor(state: string): "default" | "red" {
  return state === "healthy" ? "default" : "red";
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

export function NodeStatusScreen() {
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
          <Text className='text-white text-lg font-semibold mb-2'>Node</Text>
          <ListGroup>
            <ListItem title='Name' value={healthz.data.node.name} />
            <ListItem title='Node id' value={healthz.data.node.id} />
            <ListItem
              title='Mode'
              value={healthz.data.node.dev ? "--dev" : "installed"}
            />
            <ListItem
              title='Data directory'
              value={healthz.data.node.data_dir}
            />
            <ListItem
              title='Gateway port'
              value={String(healthz.data.gateway.port)}
            />
          </ListGroup>

          <View className='h-4' />

          <Text className='text-white text-lg font-semibold mb-2'>
            Children
          </Text>
          <ListGroup
            description={
              <Text className='text-[#9899A1] text-xs'>
                A version of "—" means the child is disabled, not answering, or
                has no way to be asked — a real state, not an error.
              </Text>
            }
          >
            {healthz.data.children.map((child) => (
              <ListItem
                key={child.name}
                title={child.name}
                subtitle={[
                  child.enabled ? child.state : "disabled",
                  child.port ? `port ${child.port}` : null,
                  child.restarts ? `${child.restarts} restart(s)` : null,
                ]
                  .filter(Boolean)
                  .join(" • ")}
                value={versionOf(child.name, child.version, status.data)}
                textColor={child.enabled ? stateColor(child.state) : "default"}
              />
            ))}
          </ListGroup>

          <View className='h-4' />

          <Text className='text-white text-lg font-semibold mb-2'>
            StingStream.Core
          </Text>
          {status.data && (
            <ListGroup>
              <ListItem
                title='First run'
                value={status.data.FirstRun ? "yes" : "no"}
              />
              <ListItem
                title='Inventory records'
                value={String(status.data.InventoryRecords)}
              />
              <ListItem
                title='Hashing queue'
                value={String(status.data.Hashing?.Queued ?? 0)}
              />
              <ListItem
                title='Core database'
                value={status.data.CoreDatabase ?? "unknown"}
              />
            </ListGroup>
          )}

          <View className='h-4' />

          <Text className='text-white text-lg font-semibold mb-2'>Mesh</Text>
          {mesh.data ? (
            <ListGroup>
              <ListItem title='Node id' value={mesh.data.Node} />
              <ListItem title='Version' value={mesh.data.Version} />
              <ListItem
                title='Groups joined'
                value={String(mesh.data.Groups ?? 0)}
              />
              <ListItem
                title='Available streams'
                value={String(mesh.data.AvailableStreams ?? 0)}
              />
              <ListItem
                title='Relay'
                value={mesh.data.RelayUrls?.join(", ") || "none"}
              />
              <ListItem
                title='Direct addresses'
                value={mesh.data.DirectAddrs?.join(", ") || "none"}
              />
            </ListGroup>
          ) : (
            <GapNotice
              title="Mesh status isn't available"
              detail="This node's mesh isn't answering — see docs/ARCHITECTURE.md for M3's mesh status."
            />
          )}

          <View className='h-4' />

          <SideDoorSection />
        </>
      )}
    </QueryState>
  );
}
