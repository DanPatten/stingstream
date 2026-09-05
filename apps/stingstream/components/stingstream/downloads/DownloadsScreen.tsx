import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { formatBytes } from "@/lib/stingstream/arr-types";
import { useNodeStatus } from "@/lib/stingstream/hooks";
import { useHealthz } from "@/lib/stingstream/status";
import { GapNotice } from "../shared/GapNotice";
import { QueryState } from "../shared/ScreenState";

function rate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function DownloadsScreen() {
  const status = useNodeStatus();
  const healthz = useHealthz();

  const nzbget = healthz.data?.children.find((c) => c.name === "nzbget");
  const torrents = status.data?.Torrents;
  const hashing = status.data?.Hashing;

  return (
    <QueryState
      isLoading={status.isLoading}
      error={status.error}
      onRetry={status.refetch}
    >
      <Text className='text-white text-lg font-semibold mb-2'>
        Engine health
      </Text>
      <ListGroup>
        <ListItem
          title='Torrent engine'
          subtitle={
            torrents?.Running
              ? `Running • ${torrents.Count ?? 0} active • ${rate(torrents.DownloadRate ?? 0)} down / ${rate(torrents.UploadRate ?? 0)} up`
              : "Stopped"
          }
          textColor={torrents?.Running ? "default" : "red"}
        />
        <ListItem
          title='Usenet engine (NZBGet)'
          subtitle={
            nzbget
              ? `${nzbget.state}${nzbget.restarts ? ` • ${nzbget.restarts} restart(s)` : ""}`
              : healthz.isLoading
                ? "Checking…"
                : "Unknown"
          }
          textColor={nzbget?.state === "healthy" ? "default" : "red"}
        />
        <ListItem
          title='Hashing queue'
          subtitle={`${hashing?.Queued ?? 0} file(s) queued for BLAKE3 hashing`}
        />
      </ListGroup>

      <View className='h-4' />

      <Text className='text-white text-lg font-semibold mb-2'>Downloads</Text>
      <GapNotice
        title="Per-download detail isn't available yet"
        detail="StingStream.Core doesn't expose a unified per-item torrent/usenet list (progress, speed, pause/resume/remove) to the app yet — only the aggregate engine status above is real. The embedded engines already support this through their own APIs (the qBittorrent-compatible shim and NZBGet's JSON-RPC); Core just doesn't proxy it to a Jellyfin-authenticated caller yet. See docs/UI-API-GAPS.md."
      />
    </QueryState>
  );
}
