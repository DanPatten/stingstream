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

const SECTIONS: Section[] = ["users", "libraries", "transcoding", "logs"];

/**
 * A section name from a URL, or `users`.
 *
 * Narrowed rather than cast: the value arrives from a query string, and a screen that trusted it
 * would render nothing at all for a typo — four `&&`s that all miss, and a blank page under a
 * segmented control.
 */
export const sectionFromParam = (value: string | undefined): Section =>
  SECTIONS.find((s) => s === value) ?? "users";

/**
 * Everything here goes through Jellyfin's own API (`/jellyfin/*`), not
 * StingStream.Core — these are Jellyfin server-admin features, and this node
 * always talks to its own Jellyfin (see docs/ARCHITECTURE.md).
 */
export function AdminScreen({
  initialSection = "users",
}: {
  /**
   * Which tab to open on.
   *
   * Home's empty state offers **Add media**, and landing on the account list is not that. A screen
   * with tabs that always opens on the first one cannot be linked to, and a button that promises
   * one thing and shows another is the bug Dan reported.
   */
  initialSection?: Section;
} = {}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>(initialSection);
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
