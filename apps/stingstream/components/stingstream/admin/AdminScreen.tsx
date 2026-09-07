import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { RefreshScreen } from "../shared/RefreshScreen";
import { SegmentedControlBar } from "../shared/SegmentedControl";
import { LibrariesSection } from "./LibrariesSection";
import { LogsSection } from "./LogsSection";
import { TranscodingSection } from "./TranscodingSection";
import { UsersSection } from "./UsersSection";

type Section = "users" | "libraries" | "transcoding" | "logs";

/**
 * Everything here goes through Jellyfin's own API (`/jellyfin/*`), not
 * StingStream.Core — these are Jellyfin server-admin features, and this node
 * always talks to its own Jellyfin (see docs/ARCHITECTURE.md).
 */
export function AdminScreen() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("users");
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        q.queryKey[0] === "stingstream" &&
        typeof q.queryKey[1] === "string" &&
        q.queryKey[1].startsWith("jellyfin-"),
    });
    setRefreshing(false);
  };

  return (
    <View style={{ flex: 1 }}>
      <SegmentedControlBar
        segments={[
          { key: "users", label: t("admin.tab_users") },
          { key: "libraries", label: t("admin.tab_libraries") },
          { key: "transcoding", label: t("admin.tab_transcoding") },
          { key: "logs", label: t("admin.tab_logs") },
        ]}
        value={section}
        onChange={(v) => setSection(v as Section)}
      />
      <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
        {section === "users" && <UsersSection />}
        {section === "libraries" && <LibrariesSection />}
        {section === "transcoding" && <TranscodingSection />}
        {section === "logs" && <LogsSection />}
      </RefreshScreen>
    </View>
  );
}
