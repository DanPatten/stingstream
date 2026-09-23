import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  type ConnectivityTestResult,
  type ExternalDownloadClientSettings,
  useAddExternalDownloadClient,
  useDeleteExternalDownloadClient,
  useExternalDownloadClients,
  useTestExternalDownloadClient,
  useUpdateExternalDownloadClient,
} from "@/lib/stingstream/hooks";
import { confirmDestructive } from "../shared/confirm";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { QueryState } from "../shared/ScreenState";
import { FormSwitch, SectionEmptyState } from "./fields";

/**
 * The download clients this server sends grabs to. Gap 8.
 *
 * All of them run by the user: StingStream ran its own until 2026-09-23 (an
 * in-process torrent engine and a bundled NZBGet), and this card used to lead
 * with their switches, with the user's own clients as an extra underneath. Dan:
 * "Remove the built in torrent client and require an external client". So this
 * is the whole card, and a server with none shows the one action that fixes it.
 *
 * Pushed into both managers the same way indexers are, from each app's own
 * `downloadclient/schema`, so an implementation StingStream has never heard of
 * still works as long as the manager has it.
 */
export function DownloadClientsSection() {
  const { t } = useTranslation();
  const { color, accent } = useTheme();
  const clients = useExternalDownloadClients();
  const add = useAddExternalDownloadClient();
  const update = useUpdateExternalDownloadClient();
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

  // The same form adds and edits, and saves on its button rather than as it is typed: a host and a
  // port are only right together, and a half-typed one would be pushed to both managers on blur.
  const editing = !!form.Id;

  const close = () => {
    setForm(emptyClient);
    setVerdict(null);
    setShowPassword(false);
    setOpen(false);
  };

  const openEdit = (client: ExternalDownloadClientSettings) => {
    setForm({ ...emptyClient, ...client });
    setVerdict(null);
    setShowPassword(false);
    setOpen(true);
  };

  const submit = async () => {
    try {
      if (form.Id) {
        await update.mutateAsync({ ...form, Id: form.Id });
        toast.success(
          t("server_settings.external_clients_saved_toast", {
            name: form.Name,
          }),
        );
      } else {
        await add.mutateAsync(form);
        toast.success(
          t("server_settings.external_clients_added_toast", {
            name: form.Name,
          }),
        );
      }
      close();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t(
              editing
                ? "server_settings.external_clients_save_error"
                : "server_settings.external_clients_add_error",
            ),
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
            : t("server_settings.external_clients_test_error"),
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
      await remove.mutateAsync(client.Id ?? "");
      if (form.Id === client.Id) close();
      toast.success(t("server_settings.external_clients_removed_toast"));
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
        title={t("server_settings.download_clients_title")}
        accessory={
          <Button
            variant='secondary'
            size='sm'
            icon={open ? "close" : "add"}
            onPress={() => (open ? close() : setOpen(true))}
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
            backgroundColor: color.bg["1"],
            padding: 16,
            marginBottom: 12,
          }}
        >
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
                      : color.bg["3"],
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
          <FormSwitch
            title={t("server_settings.external_clients_use_ssl_title")}
            value={form.UseSsl ?? false}
            onValueChange={(v) => set("UseSsl", v)}
          />
          <FormSwitch
            title={t("server_settings.indexers_for_movies")}
            value={form.ForMovies ?? true}
            onValueChange={(v) => set("ForMovies", v)}
          />
          <FormSwitch
            title={t("server_settings.indexers_for_series")}
            value={form.ForSeries ?? true}
            onValueChange={(v) => set("ForSeries", v)}
          />
          <FormSwitch
            title={t("server_settings.remove_completed_title")}
            value={form.RemoveCompletedDownloads ?? true}
            onValueChange={(v) => set("RemoveCompletedDownloads", v)}
          />
          <FormSwitch
            title={t("server_settings.remove_failed_title")}
            value={form.RemoveFailedDownloads ?? true}
            onValueChange={(v) => set("RemoveFailedDownloads", v)}
          />
          {editing && (
            <FormSwitch
              title={t("server_settings.enabled_label")}
              value={form.Enabled ?? true}
              onValueChange={(v) => set("Enabled", v)}
            />
          )}

          {verdict && (
            <Text
              variant='caption'
              tone={verdict.Ok ? undefined : "danger"}
              style={[
                { marginBottom: 8 },
                verdict.Ok ? { color: color.state.success } : undefined,
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
              loading={add.isPending || update.isPending}
              onPress={() => void submit()}
            >
              {editing
                ? t("server_settings.save_changes_action")
                : t("server_settings.external_clients_add_client_action")}
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
          <SectionEmptyState
            title={t("server_settings.external_clients_empty_title")}
            detail={t("server_settings.external_clients_empty_detail")}
            icon='download'
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
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  {c.Enabled === false ? (
                    <Pill
                      label={t("server_settings.disabled_label")}
                      tone='neutral'
                      size='sm'
                    />
                  ) : null}
                  <Pressable
                    onPress={() => openEdit(c)}
                    hitSlop={8}
                    accessibilityRole='button'
                    accessibilityLabel={t(
                      "server_settings.external_clients_edit_action",
                      { name: c.Name },
                    )}
                  >
                    <Text tone='accent' weight='semibold'>
                      {t("server_settings.edit_action")}
                    </Text>
                  </Pressable>
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
                </View>
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
 * already running. NZBGet here is the user's own server; the one StingStream
 * used to bundle is gone. The name is matched case-insensitively against the app's own
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
  Priority: 1,
  ForMovies: true,
  ForSeries: true,
  RemoveCompletedDownloads: true,
  RemoveFailedDownloads: true,
};
