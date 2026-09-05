import { useState } from "react";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import type { DownloadClientSettings } from "@/lib/stingstream/hooks";
import { GapNotice } from "../shared/GapNotice";
import { SaveBar, TextFieldRow, ToggleRow } from "./fields";

export function DownloadClientsSection({
  value,
  onSave,
  saving,
}: {
  value: DownloadClientSettings;
  onSave: (next: DownloadClientSettings) => Promise<void>;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);

  const set = <K extends keyof DownloadClientSettings>(
    key: K,
    v: DownloadClientSettings[K],
  ) => setDraft((d) => ({ ...d, [key]: v }));

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>
        Download clients
      </Text>

      <ListGroup title='Torrent engine (embedded, MonoTorrent)'>
        <ToggleRow
          title='Enabled'
          value={draft.TorrentsEnabled ?? false}
          onValueChange={(v) => set("TorrentsEnabled", v)}
        />
        <ToggleRow
          title='Join public BitTorrent DHT'
          subtitle='Off by default. A trackerless magnet is refused up front rather than stalling while off.'
          value={draft.TorrentDhtEnabled ?? false}
          onValueChange={(v) => set("TorrentDhtEnabled", v)}
        />
        <ToggleRow
          title='Local peer discovery'
          value={draft.TorrentLocalPeerDiscovery ?? false}
          onValueChange={(v) => set("TorrentLocalPeerDiscovery", v)}
        />
        <TextFieldRow
          title='Listen port'
          subtitle='0 asks the OS for an ephemeral port'
          value={String(draft.TorrentListenPort ?? 0)}
          keyboardType='number-pad'
          onChangeText={(v) =>
            set("TorrentListenPort", Number.parseInt(v, 10) || 0)
          }
        />
      </ListGroup>

      <View className='h-3' />

      <ListGroup title='Usenet engine (bundled NZBGet)'>
        <ToggleRow
          title='Enabled'
          value={draft.UsenetEnabled ?? false}
          onValueChange={(v) => set("UsenetEnabled", v)}
        />
      </ListGroup>

      <View className='h-3' />

      <ListGroup title='Housekeeping'>
        <ToggleRow
          title='Remove completed downloads'
          value={draft.RemoveCompletedDownloads ?? false}
          onValueChange={(v) => set("RemoveCompletedDownloads", v)}
        />
        <ToggleRow
          title='Remove failed downloads'
          value={draft.RemoveFailedDownloads ?? false}
          onValueChange={(v) => set("RemoveFailedDownloads", v)}
        />
      </ListGroup>

      <View className='h-3' />
      <GapNotice
        title="Adding an external download client isn't available yet"
        detail='StingStream runs the two engines above itself; the shared settings model has no slot for a third-party client (a separate qBittorrent, Transmission, SABnzbd...) yet. See docs/UI-API-GAPS.md.'
      />

      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(value)}
        onSave={async () => {
          try {
            await onSave(draft);
            toast.success("Download client settings saved");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not save");
          }
        }}
      />
    </View>
  );
}
