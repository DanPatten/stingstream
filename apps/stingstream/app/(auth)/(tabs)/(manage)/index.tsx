import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { ActivitySection } from "@/components/stingstream/manage/ActivitySection";
import { CalendarSection } from "@/components/stingstream/manage/CalendarSection";
import { MoviesSection } from "@/components/stingstream/manage/MoviesSection";
import { SeriesSection } from "@/components/stingstream/manage/SeriesSection";
import { RefreshScreen } from "@/components/stingstream/shared/RefreshScreen";
import { RequiresAdmin } from "@/components/stingstream/shared/RequiresAdmin";
import { SegmentedControlBar } from "@/components/stingstream/shared/SegmentedControl";

type Section = "movies" | "series" | "calendar" | "activity";

export default function ManagePage() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("movies");
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const onRefresh = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ["stingstream"] });
    setRefreshing(false);
  };

  return (
    <RequiresAdmin>
      <View style={{ flex: 1 }}>
        <View testID='manage-tabs'>
          <SegmentedControlBar
            segments={[
              { key: "movies", label: t("manage.tab_movies") },
              { key: "series", label: t("manage.tab_series") },
              { key: "calendar", label: t("manage.tab_calendar") },
              { key: "activity", label: t("manage.tab_activity") },
            ]}
            value={section}
            onChange={(v) => setSection(v as Section)}
          />
        </View>
        <RefreshScreen refreshing={refreshing} onRefresh={onRefresh}>
          {section === "movies" && <MoviesSection />}
          {section === "series" && <SeriesSection />}
          {section === "calendar" && <CalendarSection />}
          {section === "activity" && <ActivitySection />}
        </RefreshScreen>
      </View>
    </RequiresAdmin>
  );
}
