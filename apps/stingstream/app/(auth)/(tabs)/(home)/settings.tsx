import { Redirect } from "expo-router";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Input } from "@/components/common/Input";
import { PageContainer } from "@/components/common/PageContainer";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { ProfileHeader } from "@/components/settings/ProfileHeader";
import { SettingsShell } from "@/components/settings/SettingsShell";
import {
  buildSettingsCategories,
  flattenCategories,
  type SettingsCategory,
} from "@/components/shell/buildSettingsCategories";
import {
  buildSettingsSearchIndex,
  searchSettings,
} from "@/components/shell/settingsSearchIndex";
import { settingsTwoPane } from "@/constants/Settings";
import { space } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useRequestsMode } from "@/lib/stingstream/requests";
import { userAtom } from "@/providers/JellyfinProvider";

// TV keeps its own settings screen entirely — see `docs/conventions/tv.md`.
const SettingsTV = Platform.isTV ? require("./settings.tv").default : null;

/**
 * `/settings` — the category list on a phone, and the first category on a desktop.
 *
 * **There is no landing page above the two-pane threshold.** There was one for
 * an afternoon: an overview pane with the profile card, a sentence saying to
 * pick something on the left, and a legend explaining the scope badges. Dan:
 * *"not a fan of this landing page or what a badge means (we dont need that)
 * what do most apps do when clicking settings"* — and the answer is that they
 * open a settings *page*. macOS, Windows and Plex all land you on a real pane
 * with real controls; none of them spends a screen telling you the navigation
 * exists next to the navigation.
 *
 * So it redirects to the first category, which is a redirect rather than
 * rendering Profile in place: one canonical URL per pane, and the address bar
 * says which one you are on. It is also why the redirect reads the built list
 * instead of hard-coding `/settings/profile` — the first category is a rule in
 * `buildSettingsCategories`, and this should follow it if it changes.
 *
 * Below the threshold this is the list it always was, only grouped by domain
 * instead of by "General / Sharing / Server" and with a search box over it. A
 * list is what a phone should do, and what every phone settings app does. The
 * box has to be here because the top bar does not exist at that width; above
 * it, the same index is in the top bar, which pivots to "Search settings…".
 */
function SettingsMobile() {
  const { t } = useTranslation();
  const { isWebWide, width } = useBreakpoint();
  const user = useAtomValue(userAtom);
  const first = flattenCategories(buildSettingsCategories(user, t))[0];

  if (settingsTwoPane(width, isWebWide) && first) {
    return <Redirect href={first.route as never} />;
  }

  return (
    <SettingsShell>
      <CategoryList />
    </SettingsShell>
  );
}

/** The compact list: profile, a search box, then the categories in groups. */
const CategoryList: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const user = useAtomValue(userAtom);
  const [term, setTerm] = useState("");

  const groups = useMemo(() => buildSettingsCategories(user, t), [user, t]);
  // The request policy controls disappear with the tab that holds them when no indexer is
  // configured, so a search result cannot lead to a pane that will not draw them.
  const requestsMode = useRequestsMode();
  const index = useMemo(
    () => buildSettingsSearchIndex(user, t, requestsMode),
    [user, t, requestsMode],
  );
  const matches = useMemo(() => searchSettings(index, term), [index, term]);
  const searching = term.trim().length > 0;

  const open = (route: string) => router.navigate(route as never);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior='automatic'
      contentContainerStyle={{
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <PageContainer width='settings'>
        <View
          style={{
            paddingTop: Platform.OS === "android" ? 10 : 16,
            paddingBottom: 32,
          }}
        >
          <ProfileHeader />

          <View style={{ marginTop: space["4"] }}>
            <Input
              testID='settings-search'
              icon='search'
              value={term}
              onChangeText={setTerm}
              placeholder={t("home.settings.search.placeholder")}
              accessibilityLabel={t("home.settings.search.placeholder")}
              autoCorrect={false}
            />
          </View>

          {searching ? (
            <View testID='settings-search-results' style={{ marginTop: 16 }}>
              {matches.length === 0 ? (
                <View style={{ paddingHorizontal: 16, paddingVertical: 24 }}>
                  <Text variant='body' tone='secondary'>
                    {t("home.settings.search.no_results")}
                  </Text>
                  <Text
                    variant='caption'
                    tone='tertiary'
                    style={{ marginTop: 4 }}
                  >
                    {t("home.settings.search.no_results_detail")}
                  </Text>
                </View>
              ) : (
                <ListGroup title={t("home.settings.search.results_label")}>
                  {matches.map((entry) => (
                    <ListItem
                      key={entry.id}
                      testID={`settings-search-result-${entry.id}`}
                      title={entry.label}
                      subtitle={entry.categoryLabel}
                      showArrow
                      onPress={() => open(entry.href)}
                    />
                  ))}
                </ListGroup>
              )}
            </View>
          ) : (
            groups.map((group, groupIndex) => (
              <View
                key={group.key}
                testID={group.testID}
                style={{ marginTop: groupIndex === 0 ? 16 : 24 }}
              >
                <ListGroup title={group.title}>
                  {group.categories.map((category: SettingsCategory) => (
                    <ListItem
                      key={category.key}
                      testID={category.testID}
                      icon={category.icon}
                      title={category.label}
                      subtitle={category.detail}
                      showArrow
                      onPress={() => open(category.route)}
                    />
                  ))}
                </ListGroup>
              </View>
            ))
          )}
        </View>
      </PageContainer>
    </ScrollView>
  );
};

export default function settings() {
  if (Platform.isTV && SettingsTV) {
    return <SettingsTV />;
  }

  return <SettingsMobile />;
}
