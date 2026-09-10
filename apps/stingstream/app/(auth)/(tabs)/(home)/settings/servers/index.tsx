import { useLocalSearchParams } from "expo-router";
import { ServersPane } from "@/components/settings/panes/ServersPane";
import { SettingsPage } from "@/components/settings/SettingsPage";

export default function ServersSettingsPage() {
  // `?advanced=1` arrives from a minted invite whose link only works on this network: the fix is
  // the address field, which lives inside a collapsed disclosure on this screen. Landing here with
  // it still folded away is the same dead end with an extra step.
  const { advanced } = useLocalSearchParams<{ advanced?: string }>();

  return (
    // Not behind `RequiresAdmin`. The linked-servers block inside is only mounted for an
    // administrator -- queries included, so a member fires none of the elevated calls -- and what
    // is left is the server the reader runs themselves, which is theirs to decide about.
    <SettingsPage categoryKey='servers'>
      <ServersPane openAdvanced={advanced === "1"} />
    </SettingsPage>
  );
}
