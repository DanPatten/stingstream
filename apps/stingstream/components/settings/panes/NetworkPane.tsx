import type { NetworkConfiguration } from "@jellyfin/sdk/lib/generated-client/models";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import { DomainsScreen } from "@/components/stingstream/domains/DomainsScreen";
import {
  SaveStatus,
  TextFieldRow,
  ToggleRow,
} from "@/components/stingstream/settings/fields";
import { useAutosave } from "@/components/stingstream/settings/useAutosave";
import {
  QueryState,
  stateOf,
} from "@/components/stingstream/shared/ScreenState";
import { space } from "@/constants/theme";
import {
  formatList,
  parseList,
  useNetworkConfiguration,
  useUpdateNetworkConfiguration,
} from "@/lib/stingstream/jellyfinConfig";
import { FocusTarget } from "../FocusTarget";
import { LocalNetworkSettings } from "../LocalNetworkSettings";
import { ScopedBlock, SettingsPane } from "./SettingsPane";

/**
 * How this server is reached from outside the house.
 *
 * One page since 2026-09-13. Domains used to be a page of its own beside this
 * one, and the two answered the same question. The domain and tunnel lead,
 * because an address is what most people arrive wanting; the ports, proxies and
 * certificate that decide how that address is served follow.
 *
 * There is no "Current server" group reporting the Remote and Active URLs this
 * app happened to be using. It repeated the address card as a diagnostic, and
 * Dan struck it out; the one useful thing it knew, a domain the app reaches the
 * server through, is now offered for saving by `DomainsScreen`. Everything else
 * that decides the answer lives in Jellyfin's own network document and is editable here: the
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
  const {
    draft,
    set: edit,
    saving,
  } = useAutosave({
    value: query.data,
    save: async (next) => {
      try {
        // The whole document, never a patch: `updateNamedConfiguration` replaces,
        // so a partial body resets every field it does not name.
        await update.mutateAsync(next);
        toast.success(t("home.settings.network.saved"));
      } catch (e) {
        toast.error(
          e instanceof Error
            ? e.message
            : t("home.settings.network.save_failed"),
        );
      }
    },
  });

  // A switch is the decision itself, so it is sent at once; a field is still being typed, so it
  // waits for the pause `useAutosave` counts out.
  const set = <K extends keyof NetworkConfiguration>(
    key: K,
    value: NetworkConfiguration[K],
    options?: { now?: boolean },
  ) => edit((d) => ({ ...d, [key]: value }), options);

  return (
    <SettingsPane
      title={t("home.settings.nav.network")}
      detail={t("home.settings.nav.network_hint")}
    >
      <DomainsScreen />

      <View style={{ marginTop: space["6"] }}>
        <QueryState {...stateOf(query)}>
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
                    onValueChange={(v) =>
                      set("EnableRemoteAccess", v, { now: true })
                    }
                  />
                  <ToggleRow
                    title={t("home.settings.network.upnp_title")}
                    subtitle={t("home.settings.network.upnp_detail")}
                    value={draft.EnableUPnP ?? false}
                    onValueChange={(v) => set("EnableUPnP", v, { now: true })}
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
                    onValueChange={(v) => set("EnableHttps", v, { now: true })}
                  />
                  <ToggleRow
                    title={t("home.settings.network.require_https_title")}
                    subtitle={t("home.settings.network.require_https_detail")}
                    value={draft.RequireHttps ?? false}
                    onValueChange={(v) => set("RequireHttps", v, { now: true })}
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

              <SaveStatus saving={saving} />
            </View>
          ) : null}
        </QueryState>
      </View>

      <View style={{ marginTop: space["6"] }}>
        <ScopedBlock title={t("home.settings.network.this_app_title")}>
          <LocalNetworkSettings />
        </ScopedBlock>
      </View>
    </SettingsPane>
  );
};
