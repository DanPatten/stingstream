import { Platform, View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { useMesh } from "@/providers/MeshProvider";

/**
 * What this device's own embedded node is doing.
 *
 * Worth showing plainly, because it is the difference between playback arriving one hop from the
 * holder's disk and playback arriving through the home node — and nothing else in the UI would
 * ever tell the user which of those is happening.
 */
export function DeviceMeshSection() {
  const { available, running, status, peers, groups } = useMesh();

  if (!available) {
    return (
      <ListGroup
        title='This device'
        description={
          <Text className='text-[#9899A1] text-xs'>
            {Platform.OS === "web"
              ? "The browser cannot speak the mesh protocol, so streams are proxied by your home node. That always works; it is one hop longer."
              : "This build has no embedded mesh, so streams are proxied by your home node."}
          </Text>
        }
      >
        <ListItem title='Embedded node' value='Not available' />
      </ListGroup>
    );
  }

  if (!running || !status) {
    return (
      <ListGroup
        title='This device'
        description={
          <Text className='text-[#9899A1] text-xs'>
            Until it starts, streams are proxied by your home node.
          </Text>
        }
      >
        <ListItem title='Embedded node' value='Starting…' />
      </ListGroup>
    );
  }

  const online = peers.filter((p) => p.online && !p.isSelf);
  const direct = online.filter(
    (p) => p.path === "direct" || p.path === "mixed",
  ).length;
  const relayed = online.filter((p) => p.path === "relay").length;

  return (
    <ListGroup
      title='This device'
      description={
        <Text className='text-[#9899A1] text-xs'>
          A light member: it holds no library, publishes no inventory and serves
          no files. It exists so playback can dial the holder directly instead
          of going through your home node.
        </Text>
      }
    >
      <ListItem title='Name' value={status.nodeName} />
      <ListItem title='Node id' value={shorten(status.nodeId)} />
      <ListItem title='Local port' value={String(status.localPort)} />
      <ListItem
        title='Relay in use'
        value={status.homeRelay ? host(status.homeRelay) : "none (direct)"}
      />
      <ListItem title='Groups' value={String(groups.length)} />
      <ListItem
        title='Peers online'
        value={
          online.length === 0
            ? "none"
            : `${online.length} (${direct} direct, ${relayed} relayed)`
        }
      />
    </ListGroup>
  );
}

/** 64 hex characters do not fit a settings row, and the first 12 identify a node in a log. */
const shorten = (nodeId: string): string =>
  nodeId.length > 16 ? `${nodeId.slice(0, 12)}…` : nodeId;

const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The one-line summary the Settings screen shows on its Mesh row. */
export function useMeshSummary(): string {
  const { available, running, status, peers } = useMesh();
  if (!available) return "Not on this platform";
  if (!running || !status) return "Starting…";
  const online = peers.filter((p) => p.online && !p.isSelf);
  if (online.length === 0) return "No peers online";
  const relayed = online.filter((p) => p.path === "relay").length;
  return relayed === online.length
    ? `${online.length} online, relayed`
    : `${online.length} online, direct`;
}

/** Spacer used by the screens that stack several of these. */
export const SectionGap = () => <View className='h-4' />;
