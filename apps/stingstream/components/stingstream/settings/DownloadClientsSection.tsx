import { useState } from "react";
import { TextInput, TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import {
  type ConnectivityTestResult,
  type DownloadClientSettings,
  type ExternalDownloadClientSettings,
  useAddExternalDownloadClient,
  useDeleteExternalDownloadClient,
  useExternalDownloadClients,
  useTestExternalDownloadClient,
} from "@/lib/stingstream/hooks";
import { confirmDestructive } from "../shared/confirm";
import { EmptyState, QueryState } from "../shared/ScreenState";
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

      <View className='h-4' />
      <ExternalClients />
      <View className='h-2' />

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

/**
 * Download clients somebody else runs. Gap 8 closed.
 *
 * Separate from the embedded engines above on purpose: those two are toggles
 * with no address, because StingStream is the thing running them. These have a
 * host, a port and credentials, and are pushed into both arrs the same way
 * indexers are — from the app's own `downloadclient/schema`, so an
 * implementation StingStream has never heard of still works as long as the arr
 * has it.
 */
function ExternalClients() {
  const clients = useExternalDownloadClients();
  const add = useAddExternalDownloadClient();
  const remove = useDeleteExternalDownloadClient();
  const test = useTestExternalDownloadClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ExternalDownloadClientSettings>(emptyClient);
  const [verdict, setVerdict] = useState<ConnectivityTestResult | null>(null);

  const set = <K extends keyof ExternalDownloadClientSettings>(
    key: K,
    v: ExternalDownloadClientSettings[K],
  ) => setForm((f) => ({ ...f, [key]: v }));

  const submit = async () => {
    try {
      await add.mutateAsync(form);
      toast.success(`Added "${form.Name}" to both apps`);
      setForm(emptyClient);
      setVerdict(null);
      setOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not add the client",
      );
    }
  };

  const runTest = async () => {
    setVerdict(null);
    try {
      setVerdict(await test.mutateAsync(form));
    } catch (err) {
      setVerdict({
        Ok: false,
        Message:
          err instanceof Error ? err.message : "Neither app could be asked.",
      });
    }
  };

  const del = async (client: ExternalDownloadClientSettings) => {
    const ok = await confirmDestructive(
      `Remove "${client.Name}"?`,
      "It is removed from StingStream's settings and from Radarr and Sonarr. Downloads already running in it are not touched.",
      "Remove",
    );
    if (!ok) return;
    try {
      const result = await remove.mutateAsync(client.Id ?? "");
      toast.success(result?.Detail?.join("; ") || "Removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove");
    }
  };

  return (
    <View>
      <View className='flex-row items-center justify-between mb-2'>
        <Text className='text-white text-lg font-semibold'>
          Your own download clients
        </Text>
        <TouchableOpacity
          onPress={() => {
            setVerdict(null);
            setOpen((v) => !v);
          }}
        >
          <Text className='text-[#0584FE] font-semibold'>
            {open ? "Cancel" : "+ Add"}
          </Text>
        </TouchableOpacity>
      </View>

      {open && (
        <View className='rounded-xl bg-neutral-900 p-4 mb-3'>
          <Text className='text-[#9899A1] text-xs mb-2'>
            A client running somewhere else — a seedbox, an existing qBittorrent
            or SABnzbd. It is registered in both Radarr and Sonarr alongside the
            engines above, at a lower priority, so the embedded ones stay the
            default.
          </Text>
          <TextInput
            placeholder='Name'
            placeholderTextColor='#5A5960'
            value={form.Name ?? ""}
            onChangeText={(v) => set("Name", v)}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <View className='flex-row flex-wrap gap-2 mb-2'>
            {IMPLEMENTATIONS.map((impl) => (
              <TouchableOpacity
                key={impl.value}
                onPress={() => {
                  set("Implementation", impl.value);
                  set("Protocol", impl.protocol);
                  set("Port", impl.port);
                }}
                className='rounded-full px-3 py-1'
                style={{
                  backgroundColor:
                    form.Implementation === impl.value
                      ? Colors.primary
                      : "#2a2a2a",
                }}
              >
                <Text className='text-white text-xs'>{impl.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TextInput
            placeholder='Host, e.g. 192.168.1.20 or seedbox.example.org'
            placeholderTextColor='#5A5960'
            autoCapitalize='none'
            value={form.Host ?? ""}
            onChangeText={(v) => set("Host", v)}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <TextInput
            placeholder='Port'
            placeholderTextColor='#5A5960'
            keyboardType='number-pad'
            value={String(form.Port ?? 0)}
            onChangeText={(v) => set("Port", Number.parseInt(v, 10) || 0)}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <TextInput
            placeholder='Username (or leave blank)'
            placeholderTextColor='#5A5960'
            autoCapitalize='none'
            value={form.Username ?? ""}
            onChangeText={(v) => set("Username", v)}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <TextInput
            placeholder='Password, or an API key for SABnzbd'
            placeholderTextColor='#5A5960'
            autoCapitalize='none'
            secureTextEntry
            value={form.Password ?? ""}
            onChangeText={(v) => set("Password", v)}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <View className='flex-row gap-2 mb-2'>
            <TextInput
              placeholder='Movie category'
              placeholderTextColor='#5A5960'
              autoCapitalize='none'
              value={form.MovieCategory ?? ""}
              onChangeText={(v) => set("MovieCategory", v)}
              className='flex-1 bg-neutral-800 text-white rounded-lg px-3 py-2'
            />
            <TextInput
              placeholder='TV category'
              placeholderTextColor='#5A5960'
              autoCapitalize='none'
              value={form.TvCategory ?? ""}
              onChangeText={(v) => set("TvCategory", v)}
              className='flex-1 bg-neutral-800 text-white rounded-lg px-3 py-2'
            />
          </View>
          <TouchableOpacity
            onPress={() => set("UseSsl", !form.UseSsl)}
            className='flex-row items-center mb-3'
          >
            <View
              className='w-5 h-5 rounded mr-2 items-center justify-center'
              style={{
                backgroundColor: form.UseSsl ? Colors.primary : "#1f1f1f",
              }}
            >
              {form.UseSsl && <Text className='text-white text-xs'>✓</Text>}
            </View>
            <Text className='text-white'>Connect over HTTPS</Text>
          </TouchableOpacity>

          {verdict && (
            <Text
              className={
                verdict.Ok
                  ? "text-green-500 text-xs mb-2"
                  : "text-red-500 text-xs mb-2"
              }
            >
              {verdict.Ok ? "✓ " : "✕ "}
              {verdict.Message}
            </Text>
          )}

          <View className='flex-row gap-2'>
            <TouchableOpacity
              disabled={test.isPending}
              onPress={() => void runTest()}
              className='flex-1 rounded-lg py-2 items-center bg-neutral-800'
            >
              <Text className='text-white'>
                {test.isPending ? "Testing…" : "Test"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={add.isPending}
              onPress={() => void submit()}
              className='flex-1 rounded-lg py-2 items-center'
              style={{ backgroundColor: Colors.primary }}
            >
              <Text className='text-white font-semibold'>
                {add.isPending ? "Adding…" : "Add client"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <QueryState
        isLoading={clients.isLoading}
        error={clients.error}
        onRetry={clients.refetch}
      >
        {(clients.data ?? []).length === 0 ? (
          <EmptyState
            title='No external clients'
            detail='StingStream downloads through its own two engines. Add one here if you already run a client somewhere else.'
          />
        ) : (
          <ListGroup>
            {(clients.data ?? []).map((c) => (
              <ListItem
                key={c.Id}
                title={c.Name ?? ""}
                subtitle={[
                  c.Implementation,
                  `${c.UseSsl ? "https" : "http"}://${c.Host}:${c.Port}`,
                  c.Protocol,
                  c.ForMovies && c.ForSeries
                    ? "Movies + Series"
                    : c.ForMovies
                      ? "Movies"
                      : "Series",
                ]
                  .filter(Boolean)
                  .join(" • ")}
                textColor='red'
                onPress={() => void del(c)}
              >
                <Text className='text-red-600'>Remove</Text>
              </ListItem>
            ))}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}

/**
 * The implementations NzbDrone ships, with the port each one uses by default.
 *
 * A shortlist, not the full set: these are the six somebody is realistically
 * already running. The name is matched case-insensitively against the app's own
 * schema, so a client not listed here still works — it just has to be typed
 * exactly, and the test button is how you find out whether it was.
 */
const IMPLEMENTATIONS: {
  value: string;
  label: string;
  protocol: string;
  port: number;
}[] = [
  {
    value: "QBittorrent",
    label: "qBittorrent",
    protocol: "torrent",
    port: 8080,
  },
  {
    value: "Transmission",
    label: "Transmission",
    protocol: "torrent",
    port: 9091,
  },
  { value: "Deluge", label: "Deluge", protocol: "torrent", port: 8112 },
  { value: "RTorrent", label: "rTorrent", protocol: "torrent", port: 8080 },
  { value: "Sabnzbd", label: "SABnzbd", protocol: "usenet", port: 8080 },
  { value: "Nzbget", label: "NZBGet", protocol: "usenet", port: 6789 },
];

const emptyClient: ExternalDownloadClientSettings = {
  Name: "",
  Implementation: "QBittorrent",
  Protocol: "torrent",
  Host: "",
  Port: 8080,
  UseSsl: false,
  UrlBase: "",
  Username: "",
  Password: "",
  MovieCategory: "radarr",
  TvCategory: "sonarr",
  Enabled: true,
  Priority: 2,
  ForMovies: true,
  ForSeries: true,
  RemoveCompletedDownloads: true,
  RemoveFailedDownloads: true,
};
