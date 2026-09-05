import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
        <SegmentedControlBar
          segments={[
            { key: "movies", label: "Movies" },
            { key: "series", label: "Series" },
            { key: "calendar", label: "Calendar" },
            { key: "activity", label: "Activity" },
          ]}
          value={section}
          onChange={(v) => setSection(v as Section)}
        />
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
