import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
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
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { SaveStatus, TextFieldRow, ToggleRow } from "./fields";
import { useAutosave } from "./useAutosave";

export function DownloadClientsSection({
  value,
  onSave,
  saving,
}: {
  value: DownloadClientSettings;
  onSave: (next: DownloadClientSettings) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const {
    draft,
    set: edit,
    saving: sending,
  } = useAutosave({
    value,
    save: async (next) => {
      try {
        await onSave(next);
        toast.success(t("server_settings.download_clients_save_success"));
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t("server_settings.save_error"),
        );
      }
    },
  });

  // A switch is a decision, so it goes at once; a field is still being typed, so it waits for the
  // pause `useAutosave` counts out.
  const set = <K extends keyof DownloadClientSettings>(
    key: K,
    v: DownloadClientSettings[K],
    options?: { now?: boolean },
  ) => edit((d) => ({ ...d, [key]: v }), options);

  if (!draft) return null;

  return (
    <View>
      <ScreenHeaderRow title={t("server_settings.download_clients_title")} />

      <ListGroup title={t("server_settings.torrent_engine_group_title")}>
        <ToggleRow
          title={t("server_settings.enabled_label")}
          value={draft.TorrentsEnabled ?? false}
          onValueChange={(v) => set("TorrentsEnabled", v, { now: true })}
        />
        <ToggleRow
          title={t("server_settings.torrent_dht_title")}
          subtitle={t("server_settings.torrent_dht_detail")}
          value={draft.TorrentDhtEnabled ?? false}
          onValueChange={(v) => set("TorrentDhtEnabled", v, { now: true })}
        />
        <ToggleRow
          title={t("server_settings.torrent_local_peer_discovery_title")}
          value={draft.TorrentLocalPeerDiscovery ?? false}
          onValueChange={(v) =>
            set("TorrentLocalPeerDiscovery", v, { now: true })
          }
        />
        <TextFieldRow
          title={t("server_settings.torrent_listen_port_title")}
          subtitle={t("server_settings.torrent_listen_port_detail")}
          value={String(draft.TorrentListenPort ?? 0)}
          keyboardType='number-pad'
          onChangeText={(v) =>
            set("TorrentListenPort", Number.parseInt(v, 10) || 0)
          }
        />
      </ListGroup>

      <View style={{ height: 12 }} />

      <ListGroup title={t("server_settings.usenet_engine_group_title")}>
        <ToggleRow
          title={t("server_settings.enabled_label")}
          value={draft.UsenetEnabled ?? false}
          onValueChange={(v) => set("UsenetEnabled", v, { now: true })}
        />
      </ListGroup>

      <View style={{ height: 12 }} />

      <ListGroup title={t("server_settings.housekeeping_group_title")}>
        <ToggleRow
          title={t("server_settings.remove_completed_title")}
          value={draft.RemoveCompletedDownloads ?? false}
          onValueChange={(v) =>
            set("RemoveCompletedDownloads", v, { now: true })
          }
        />
        <ToggleRow
          title={t("server_settings.remove_failed_title")}
          value={draft.RemoveFailedDownloads ?? false}
          onValueChange={(v) => set("RemoveFailedDownloads", v, { now: true })}
        />
      </ListGroup>

      <View style={{ height: 16 }} />
      <ExternalClients />
      <View style={{ height: 8 }} />

      <SaveStatus saving={saving || sending} />
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
  const { t } = useTranslation();
  const { accent } = useTheme();
  const clients = useExternalDownloadClients();
  const add = useAddExternalDownloadClient();
  const remove = useDeleteExternalDownloadClient();
  const test = useTestExternalDownloadClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ExternalDownloadClientSettings>(emptyClient);
  const [showPassword, setShowPassword] = useState(false);
  const [verdict, setVerdict] = useState<ConnectivityTestResult | null>(null);

  const set = <K extends keyof ExternalDownloadClientSettings>(
    key: K,
    v: ExternalDownloadClientSettings[K],
  ) => setForm((f) => ({ ...f, [key]: v }));

  const submit = async () => {
    try {
      await add.mutateAsync(form);
      toast.success(
        t("server_settings.external_clients_added_toast", { name: form.Name }),
      );
      setForm(emptyClient);
      setVerdict(null);
      setShowPassword(false);
      setOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("server_settings.external_clients_add_error"),
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
          err instanceof Error
            ? err.message
            : t("server_settings.indexers_test_error"),
      });
    }
  };

  const del = async (client: ExternalDownloadClientSettings) => {
    const ok = await confirmDestructive(
      t("server_settings.external_clients_remove_confirm_title", {
        name: client.Name,
      }),
      t("server_settings.external_clients_remove_confirm_message"),
      t("common.remove"),
    );
    if (!ok) return;
    try {
      const result = await remove.mutateAsync(client.Id ?? "");
      toast.success(
        result?.Detail?.join("; ") ||
          t("server_settings.external_clients_removed_toast"),
      );
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("server_settings.external_clients_remove_error"),
      );
    }
  };

  return (
    <View>
      <ScreenHeaderRow
        title={t("server_settings.external_clients_title")}
        accessory={
          <Button
            variant='secondary'
            size='sm'
            icon={open ? "close" : "add"}
            onPress={() => {
              setVerdict(null);
              setOpen((v) => !v);
            }}
          >
            {open
              ? t("common.cancel")
              : t("server_settings.external_clients_add_action")}
          </Button>
        }
      />

      {open && (
        <View
          style={{
            borderRadius: radius.lg,
            backgroundColor: tokens.color.bg["1"],
            padding: 16,
            marginBottom: 12,
          }}
        >
          <Text variant='caption' tone='secondary' style={{ marginBottom: 8 }}>
            {t("server_settings.external_clients_explainer")}
          </Text>
          <Input
            placeholder={t("server_settings.external_clients_name_placeholder")}
            value={form.Name ?? ""}
            onChangeText={(v) => set("Name", v)}
            style={{ marginBottom: 8 }}
          />
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 8,
            }}
          >
            {IMPLEMENTATIONS.map((impl) => (
              <Pressable
                key={impl.value}
                onPress={() => {
                  set("Implementation", impl.value);
                  set("Protocol", impl.protocol);
                  set("Port", impl.port);
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: radius.pill,
                  backgroundColor:
                    form.Implementation === impl.value
                      ? accent[500]
                      : tokens.color.bg["3"],
                }}
              >
                <Text
                  variant='caption'
                  weight='semibold'
                  tone={
                    form.Implementation === impl.value
                      ? "onAccent"
                      : "secondary"
                  }
                >
                  {impl.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Input
            placeholder={t("server_settings.external_clients_host_placeholder")}
            autoCapitalize='none'
            value={form.Host ?? ""}
            onChangeText={(v) => set("Host", v)}
            style={{ marginBottom: 8 }}
          />
          <Input
            placeholder={t("server_settings.external_clients_port_placeholder")}
            keyboardType='number-pad'
            value={String(form.Port ?? 0)}
            onChangeText={(v) => set("Port", Number.parseInt(v, 10) || 0)}
            style={{ marginBottom: 8 }}
          />
          <Input
            placeholder={t(
              "server_settings.external_clients_username_placeholder",
            )}
            autoCapitalize='none'
            value={form.Username ?? ""}
            onChangeText={(v) => set("Username", v)}
            style={{ marginBottom: 8 }}
          />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <Input
                placeholder={t(
                  "server_settings.external_clients_password_placeholder",
                )}
                autoCapitalize='none'
                secureTextEntry={!showPassword}
                value={form.Password ?? ""}
                onChangeText={(v) => set("Password", v)}
              />
            </View>
            <Pressable
              onPress={() => setShowPassword((v) => !v)}
              hitSlop={8}
              accessibilityRole='button'
            >
              <Text variant='caption' weight='semibold' tone='accent'>
                {showPassword ? t("common.hide") : t("common.show")}
              </Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
            <View style={{ flex: 1 }}>
              <Input
                placeholder={t(
                  "server_settings.external_clients_movie_category_placeholder",
                )}
                autoCapitalize='none'
                value={form.MovieCategory ?? ""}
                onChangeText={(v) => set("MovieCategory", v)}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Input
                placeholder={t(
                  "server_settings.external_clients_tv_category_placeholder",
                )}
                autoCapitalize='none'
                value={form.TvCategory ?? ""}
                onChangeText={(v) => set("TvCategory", v)}
              />
            </View>
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <Text>{t("server_settings.external_clients_use_ssl_title")}</Text>
            <SettingSwitch
              value={form.UseSsl ?? false}
              onValueChange={(v) => set("UseSsl", v)}
            />
          </View>

          {verdict && (
            <Text
              variant='caption'
              tone={verdict.Ok ? undefined : "danger"}
              style={[
                { marginBottom: 8 },
                verdict.Ok ? { color: tokens.color.state.success } : undefined,
              ]}
            >
              {verdict.Message}
            </Text>
          )}

          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              variant='secondary'
              style={{ flex: 1 }}
              loading={test.isPending}
              onPress={() => void runTest()}
            >
              {t("server_settings.test_action")}
            </Button>
            <Button
              variant='primary'
              style={{ flex: 1 }}
              loading={add.isPending}
              onPress={() => void submit()}
            >
              {t("server_settings.external_clients_add_client_action")}
            </Button>
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
            title={t("server_settings.external_clients_empty_title")}
            detail={t("server_settings.external_clients_empty_detail")}
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
                  c.ForMovies && c.ForSeries
                    ? t("server_settings.indexers_for_both")
                    : c.ForMovies
                      ? t("server_settings.indexers_for_movies")
                      : t("server_settings.indexers_for_series"),
                ]
                  .filter(Boolean)
                  .join(" • ")}
              >
                <Pressable
                  onPress={() => void del(c)}
                  hitSlop={8}
                  accessibilityRole='button'
                  accessibilityLabel={t(
                    "server_settings.external_clients_remove_action",
                    { name: c.Name },
                  )}
                >
                  <Text tone='danger' weight='semibold'>
                    {t("common.remove")}
                  </Text>
                </Pressable>
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
