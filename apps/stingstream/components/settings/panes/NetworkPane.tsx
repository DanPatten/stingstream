import type { NetworkConfiguration } from "@jellyfin/sdk/lib/generated-client/models";
import { getNodeBaseUrl } from "@stingstream/api-client";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import {
  SaveBar,
  TextFieldRow,
  ToggleRow,
} from "@/components/stingstream/settings/fields";
import { QueryState } from "@/components/stingstream/shared/ScreenState";
import { space } from "@/constants/theme";
import {
  formatList,
  parseList,
  useNetworkConfiguration,
  useUpdateNetworkConfiguration,
} from "@/lib/stingstream/jellyfinConfig";
import { apiAtom } from "@/providers/JellyfinProvider";
import { storage } from "@/utils/mmkv";
import { FocusTarget } from "../FocusTarget";
import { LocalNetworkSettings } from "../LocalNetworkSettings";
import { ScopedBlock, SettingsPane } from "./SettingsPane";

/**
 * How this server is reached from outside the house.
 *
 * The page used to be two rows reporting the addresses this app happened to be
 * using, which is a diagnostic rather than a setting — it could tell you the
 * remote URL was wrong but not let you fix it. Everything that decides the
 * answer lives in Jellyfin's own network document and is editable here: the
 * base URL a reverse proxy mounts the server under, the proxies whose
 * forwarded-for headers are trusted, the ports announced to the router, and the
 * certificate an HTTPS listener serves.
 *
 * The certificate password is deliberately a plain field with no reveal and no
 * read-back: Jellyfin returns it in the document, so hiding it would be theatre
 * — but the row says what it is for rather than inviting a look.
 */
export const NetworkPane: React.FC = () => {
  const { t } = useTranslation();
  const query = useNetworkConfiguration();
  const update = useUpdateNetworkConfiguration();
  const [draft, setDraft] = useState<NetworkConfiguration | null>(null);

  // Seeded once, then owned by the form: re-seeding on every refetch would
  // throw away half-typed edits the moment react-query revalidated.
  useEffect(() => {
    if (query.data && !draft) setDraft(query.data);
  }, [query.data, draft]);

  const dirty =
    !!draft && JSON.stringify(draft) !== JSON.stringify(query.data ?? null);

  const set = <K extends keyof NetworkConfiguration>(
    key: K,
    value: NetworkConfiguration[K],
  ) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = async () => {
    if (!draft) return;
    try {
      // The whole document, never a patch: `updateNamedConfiguration` replaces,
      // so a partial body resets every field it does not name.
      await update.mutateAsync(draft);
      toast.success(t("home.settings.network.saved"));
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t("home.settings.network.save_failed"),
      );
    }
  };

  return (
    <SettingsPane
      title={t("home.settings.nav.network")}
      scope='server'
      detail={t("home.settings.nav.network_hint")}
    >
      <CurrentAddresses />

      <View style={{ marginTop: space["6"] }}>
        <QueryState
          isLoading={query.isLoading}
          error={query.error}
          onRetry={query.refetch}
        >
          {draft ? (
            <View style={{ gap: space["4"] }}>
              <FocusTarget
                id={["remote-access", "port-forwarding", "public-port"]}
              >
                <ListGroup
                  title={t("home.settings.network.remote_access_title")}
                >
                  <ToggleRow
                    title={t("home.settings.network.enable_remote_title")}
                    subtitle={t("home.settings.network.enable_remote_detail")}
                    value={draft.EnableRemoteAccess ?? true}
                    onValueChange={(v) => set("EnableRemoteAccess", v)}
                  />
                  <ToggleRow
                    title={t("home.settings.network.upnp_title")}
                    subtitle={t("home.settings.network.upnp_detail")}
                    value={draft.EnableUPnP ?? false}
                    onValueChange={(v) => set("EnableUPnP", v)}
                  />
                  <TextFieldRow
                    title={t("home.settings.network.public_port_title")}
                    subtitle={t("home.settings.network.public_port_detail")}
                    keyboardType='number-pad'
                    value={String(draft.PublicHttpPort ?? "")}
                    onChangeText={(v) =>
                      set("PublicHttpPort", Number.parseInt(v, 10) || 0)
                    }
                  />
                </ListGroup>
              </FocusTarget>

              <FocusTarget id={["base-url", "known-proxies"]}>
                <ListGroup title={t("home.settings.network.proxy_title")}>
                  <TextFieldRow
                    title={t("home.settings.network.base_url_title")}
                    subtitle={t("home.settings.network.base_url_detail")}
                    value={draft.BaseUrl ?? ""}
                    // A neutral example, not this node's own internal route: the
                    // gateway mounts the media server at '/jellyfin', and printing
                    // that here would put an upstream product's name on screen.
                    placeholder='/stingstream'
                    onChangeText={(v) => set("BaseUrl", v)}
                  />
                  <TextFieldRow
                    title={t("home.settings.network.known_proxies_title")}
                    subtitle={t("home.settings.network.known_proxies_detail")}
                    value={formatList(draft.KnownProxies)}
                    placeholder='127.0.0.1, 10.0.0.2'
                    onChangeText={(v) => set("KnownProxies", parseList(v))}
                  />
                </ListGroup>
              </FocusTarget>

              <FocusTarget id={["https", "certificate"]}>
                <ListGroup title={t("home.settings.network.https_title")}>
                  <ToggleRow
                    title={t("home.settings.network.enable_https_title")}
                    subtitle={t("home.settings.network.enable_https_detail")}
                    value={draft.EnableHttps ?? false}
                    onValueChange={(v) => set("EnableHttps", v)}
                  />
                  <ToggleRow
                    title={t("home.settings.network.require_https_title")}
                    subtitle={t("home.settings.network.require_https_detail")}
                    value={draft.RequireHttps ?? false}
                    onValueChange={(v) => set("RequireHttps", v)}
                  />
                  <TextFieldRow
                    title={t("home.settings.network.certificate_title")}
                    subtitle={t("home.settings.network.certificate_detail")}
                    value={draft.CertificatePath ?? ""}
                    onChangeText={(v) => set("CertificatePath", v)}
                  />
                  <TextFieldRow
                    title={t(
                      "home.settings.network.certificate_password_title",
                    )}
                    subtitle={t(
                      "home.settings.network.certificate_password_detail",
                    )}
                    value={draft.CertificatePassword ?? ""}
                    onChangeText={(v) => set("CertificatePassword", v)}
                  />
                </ListGroup>
              </FocusTarget>

              <SaveBar
                dirty={dirty}
                saving={update.isPending}
                onDiscard={() => setDraft(query.data ?? null)}
                onSave={save}
              />
            </View>
          ) : null}
        </QueryState>
      </View>

      <View style={{ marginTop: space["6"] }}>
        <ScopedBlock
          title={t("home.settings.network.this_app_title")}
          scope='device'
        >
          <LocalNetworkSettings />
        </ScopedBlock>
      </View>
    </SettingsPane>
  );
};

/**
 * What this app is actually talking to, which is not the same question as what
 * the server is configured to offer — and the pair is how you tell a broken
 * reverse proxy from a broken setting.
 *
 * **The node's address, not the media server's path inside it.** Both values are
 * held as `…/jellyfin`, which is the gateway's internal route rather than
 * anything a reader typed or needs: printing it verbatim put an upstream
 * product's name in visible text on this screen (the brand-word sweep caught it
 * the moment this pane existed) and told the reader nothing they could act on.
 * `getNodeBaseUrl` gives the address the node actually answers on, which is what
 * both rows are asking about.
 */
const CurrentAddresses: React.FC = () => {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const stored = storage.getString("serverUrl");
  const remote = stored ? getNodeBaseUrl(stored) : null;
  const active = api?.basePath ? getNodeBaseUrl(api.basePath) : null;

  return (
    <ListGroup title={t("home.settings.network.current_server")}>
      <ListItem
        title={t("home.settings.network.remote_url")}
        subtitle={remote ?? t("home.settings.network.not_configured")}
      />
      <ListItem
        title={t("home.settings.network.active_url")}
        subtitle={active ?? t("home.settings.network.not_connected")}
      />
    </ListGroup>
  );
};
