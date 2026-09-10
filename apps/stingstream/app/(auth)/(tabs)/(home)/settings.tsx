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
import { SettingsOverview } from "@/components/settings/SettingsOverview";
import { SettingsShell } from "@/components/settings/SettingsShell";
import {
  buildSettingsCategories,
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
import { userAtom } from "@/providers/JellyfinProvider";

// TV keeps its own settings screen entirely — see `docs/conventions/tv.md`.
const SettingsTV = Platform.isTV ? require("./settings.tv").default : null;

/**
 * `/settings` — the category list, or the two-pane overview.
 *
 * Above `SETTINGS_TWO_PANE_MIN_WIDTH` this is `SettingsShell` with no category
 * chosen: the column on the left, and an overview on the right saying who you
 * are signed in as and what the scope badges mean. That overview is what
 * answers the complaint this restructure started from — a 960 px list centred
 * in a 1440 px window, with the right two-thirds of the screen empty.
 *
 * Below it, the shell draws nothing and this is the list it always was, only
 * grouped by domain instead of by "General / Sharing / Server" and with a
 * search box over it. The top bar does not exist at that width, so the box has
 * to be here; above it the same index is reachable from the top bar, which
 * pivots to "Search settings…" on any settings route.
 */
function SettingsMobile() {
  const { isWebWide, width } = useBreakpoint();

  return (
    <SettingsShell>
      {settingsTwoPane(width, isWebWide) ? (
        <ScrollView contentInsetAdjustmentBehavior='automatic'>
          <SettingsOverview />
        </ScrollView>
      ) : (
        <CategoryList />
      )}
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
  const index = useMemo(() => buildSettingsSearchIndex(user, t), [user, t]);
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
