import { useLocalSearchParams } from "expo-router";
import { PlaybackPane } from "@/components/settings/panes/PlaybackPane";
import { SettingsPage } from "@/components/settings/SettingsPage";

export default function PlaybackSettingsPage() {
  // `?tab=audio` / `?tab=music` — the addresses the three pages this replaced
  // used to have, and what the settings search jumps to.
  const { tab } = useLocalSearchParams<{ tab?: string }>();

  return (
    <SettingsPage categoryKey='playback'>
      <PlaybackPane initialSection={tab} />
    </SettingsPage>
  );
}
