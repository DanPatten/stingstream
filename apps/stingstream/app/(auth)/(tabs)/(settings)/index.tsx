import { Platform } from "react-native";
import SettingsTV from "@/app/(auth)/(tabs)/(home)/settings.tv";
import { MoreScreen } from "@/components/shell/MoreScreen";

/**
 * One route, two screens.
 *
 * On a television this group is the Settings tab and always has been — the nav
 * rail labels it so and the D-pad walk expects it. On a phone or a narrow
 * browser window it is the fifth button of F-08's five-icon bar, "More", and
 * shows everything the bar could not fit; Settings is one row inside it.
 *
 * Reusing the group rather than adding one is deliberate: `CLAUDE.test.ts` pins
 * the list of tab groups against `docs/UI.md`, and a phone does not need a
 * tenth.
 */
export default function SettingsTabScreen() {
  return Platform.isTV ? <SettingsTV /> : <MoreScreen />;
}
