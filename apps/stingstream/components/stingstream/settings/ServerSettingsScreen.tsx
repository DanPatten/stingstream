import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import {
  useSharedSettings,
  useUpdateSharedSettings,
} from "@/lib/stingstream/hooks";
import { RefreshScreen } from "../shared/RefreshScreen";
import { QueryState } from "../shared/ScreenState";
import { SegmentedControlBar } from "../shared/SegmentedControl";
import { DownloadClientsSection } from "./DownloadClientsSection";
import { IndexersSection } from "./IndexersSection";
import { NamingSection } from "./NamingSection";
import { NotificationsSection } from "./NotificationsSection";
import { QualityProfilesSection } from "./QualityProfilesSection";
import { RootFoldersSection } from "./RootFoldersSection";
import { SyncStatusBanner } from "./SyncStatusBanner";

type Section =
  | "indexers"
  | "downloadClients"
  | "qualityProfiles"
  | "rootFolders"
  | "naming"
  | "notifications";

export function ServerSettingsScreen() {
  const { data: settings, isLoading, error, refetch } = useSharedSettings();
  const updateSettings = useUpdateSharedSettings();
  const [section, setSection] = useState<Section>("indexers");
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["stingstream"] });
    setRefreshing(false);
  };

  return (
    <View style={{ flex: 1 }}>
      <SegmentedControlBar
        segments={[
          { key: "indexers", label: "Indexers" },
          { key: "downloadClients", label: "Download clients" },
          { key: "qualityProfiles", label: "Quality profiles" },
          { key: "rootFolders", label: "Root folders" },
          { key: "naming", label: "Naming" },
          { key: "notifications", label: "Notifications" },
        ]}
        value={section}
        onChange={(v) => setSection(v as Section)}
      />
      <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
        <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
          <SyncStatusBanner />
          {settings && (
            <>
              {section === "indexers" && <IndexersSection />}
              {section === "downloadClients" && (
                <DownloadClientsSection
                  value={settings.DownloadClients!}
                  saving={updateSettings.isPending}
                  onSave={(next) =>
                    updateSettings
                      .mutateAsync({ ...settings, DownloadClients: next })
                      .then(() => {})
                  }
                />
              )}
              {section === "qualityProfiles" && (
                <QualityProfilesSection
                  value={settings.DefaultQualityProfileName ?? ""}
                  saving={updateSettings.isPending}
                  onSave={(next) =>
                    updateSettings
                      .mutateAsync({
                        ...settings,
                        DefaultQualityProfileName: next,
                      })
                      .then(() => {})
                  }
                />
              )}
              {section === "rootFolders" && (
                <RootFoldersSection
                  value={settings.RootFolders!}
                  saving={updateSettings.isPending}
                  onSave={(next) =>
                    updateSettings
                      .mutateAsync({ ...settings, RootFolders: next })
                      .then(() => {})
                  }
                />
              )}
              {section === "naming" && (
                <NamingSection
                  value={settings.Naming!}
                  saving={updateSettings.isPending}
                  onSave={(next) =>
                    updateSettings
                      .mutateAsync({ ...settings, Naming: next })
                      .then(() => {})
                  }
                />
              )}
              {section === "notifications" && (
                <NotificationsSection
                  value={settings.Notifications!}
                  saving={updateSettings.isPending}
                  onSave={(next) =>
                    updateSettings
                      .mutateAsync({ ...settings, Notifications: next })
                      .then(() => {})
                  }
                />
              )}
            </>
          )}
        </QueryState>
      </RefreshScreen>
    </View>
  );
}
