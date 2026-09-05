import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { useNodeStatus } from "@/lib/stingstream/hooks";
import { useHealthz, useMeshStatus } from "@/lib/stingstream/status";
import { GapNotice } from "../shared/GapNotice";
import { QueryState } from "../shared/ScreenState";

function stateColor(state: string): "default" | "red" {
  return state === "healthy" ? "default" : "red";
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
                Per-child version numbers aren't reported yet — see
                docs/UI-API-GAPS.md.
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
              <ListItem title='Version' value={mesh.data.version} />
              <ListItem
                title='Groups joined'
                value={String(mesh.data.groups)}
              />
              <ListItem
                title='Available streams'
                value={String(mesh.data.available_streams)}
              />
              <ListItem
                title='Relay'
                value={mesh.data.relay_urls.join(", ") || "none"}
              />
              <ListItem
                title='Direct addresses'
                value={mesh.data.direct_addrs.join(", ") || "none"}
              />
            </ListGroup>
          ) : (
            <GapNotice
              title="Mesh status isn't available"
              detail="This node's mesh child isn't answering — groups and peer streaming land in M3 (see docs/ARCHITECTURE.md)."
            />
          )}
        </>
      )}
    </QueryState>
  );
}
