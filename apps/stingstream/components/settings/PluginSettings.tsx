import * as Sentry from "@sentry/react-native";
import { useTranslation } from "react-i18next";
import { toast } from "sonner-native";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import useRouter from "@/hooks/useAppRouter";
import { useSettings } from "@/utils/atoms/settings";
import { sentryDebugInDev } from "@/utils/sentry";
import { ListGroup } from "../list/ListGroup";
import { ListItem } from "../list/ListItem";

export const PluginSettings = () => {
  const { settings, updateSettings, pluginSettings } = useSettings();

  // The lock must be visible: updateSettings drops the write for locked keys,
  // so an unlocked-looking switch would read as broken rather than pinned.
  const sentryLocked = pluginSettings?.sentryEnabled?.locked === true;

  const router = useRouter();

  const { t } = useTranslation();

  if (!settings) return null;

  return (
    <ListGroup
      title={t("home.settings.plugins.plugins_title")}
      className='mb-4'
    >
      {/* Jellyseerr is not offered. StingStream has its own Requests tab (M6): requests are made
          against the group's own index, routed to whichever member node has the indexers, and
          fulfilled through this node's Radarr and Sonarr. Pointing a second request system at the
          same arrs would mean two sources of truth about what has been asked for, two approval
          queues, and a Seerr instance that knows nothing about what the group already holds --
          which is the one thing that makes StingStream's answer different. The upstream screen and
          its settings are still in the tree (`components/settings/Jellyseerr.tsx`, the
          `jellyseerr*` settings keys, the `utils/jellyseerr` submodule) so an upstream pull still
          merges; nothing routes to them. See docs/REQUESTS.md. */}
      <ListItem
        onPress={() => router.push("/settings/plugins/streamystats/page")}
        title='Streamystats'
        showArrow
      />
      <ListItem
        onPress={() => router.push("/settings/plugins/marlin-search/page")}
        title='Marlin Search'
        showArrow
      />
      <ListItem
        onPress={() => router.push("/settings/plugins/kefinTweaks/page")}
        title='KefinTweaks'
        showArrow
      />
      {/* Lookups the client makes directly, without going through Jellyfin. */}
      <ListItem
        title={t("home.settings.plugins.wikidata_awards")}
        subtitle={t("home.settings.plugins.wikidata_awards_hint")}
      >
        <SettingSwitch
          value={settings.wikidataAwardsEnabled}
          onValueChange={(value) =>
            updateSettings({ wikidataAwardsEnabled: value })
          }
        />
      </ListItem>
      <ListItem
        title={t("home.settings.plugins.opensubtitles_enabled")}
        subtitle={t("home.settings.plugins.opensubtitles_enabled_hint")}
      >
        <SettingSwitch
          value={settings.openSubtitlesEnabled}
          onValueChange={(value) =>
            updateSettings({ openSubtitlesEnabled: value })
          }
        />
      </ListItem>
      <ListItem
        title={t("home.settings.plugins.crash_reports")}
        subtitle={t("home.settings.plugins.crash_reports_hint")}
        disabledByAdmin={sentryLocked}
      >
        <SettingSwitch
          value={settings.sentryEnabled}
          disabled={sentryLocked}
          onValueChange={(value) => updateSettings({ sentryEnabled: value })}
        />
      </ListItem>
      {/* Dev-only smoke test for the Sentry pipeline; never ships in release.
          Dev builds don't report unless EXPO_PUBLIC_SENTRY_DEBUG=1, so the
          button is hidden when the event would go nowhere. */}
      {__DEV__ && sentryDebugInDev && settings.sentryEnabled && (
        <ListItem
          title='Send test error to Sentry'
          textColor='blue'
          onPress={() => {
            Sentry.captureException(
              new Error("Sentry test error — safe to ignore"),
            );
            toast.success("Test error sent");
          }}
        />
      )}
    </ListGroup>
  );
};
