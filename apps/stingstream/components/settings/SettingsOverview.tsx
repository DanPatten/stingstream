import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { PageContainer } from "@/components/common/PageContainer";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import type { SettingsScope } from "@/components/shell/buildSettingsCategories";
import { space } from "@/constants/theme";
import { ProfileHeader } from "./ProfileHeader";
import { ScopeBadge } from "./ScopeBadge";

const SCOPES: SettingsScope[] = ["device", "account", "server"];

/**
 * What the detail pane shows before a category has been picked.
 *
 * The two-pane layout has to answer for the space it takes: at 1440 the old
 * single-column Settings left the right two-thirds of the window empty, and a
 * category column beside an empty pane would be the same complaint with an
 * extra rule drawn down it.
 *
 * So it shows the two things that are true before you have chosen anything —
 * who you are signed in as, and what the badges on every page mean. The legend
 * is here rather than repeated per page because the vocabulary only has to be
 * learned once, and this is the one screen everybody lands on first.
 *
 * Not drawn below the two-pane threshold: there the landing page is the
 * category list itself, and a legend above a list nobody has read yet is a wall
 * between the reader and the thing they came for.
 */
export const SettingsOverview: React.FC = () => {
  const { t } = useTranslation();

  return (
    <PageContainer
      testID='settings-overview'
      width='settings'
      style={{ paddingTop: space["6"] }}
    >
      <ProfileHeader />

      <View style={{ marginTop: space["6"] }}>
        <Text variant='title' weight='semibold'>
          {t("home.settings.overview.title")}
        </Text>
        <Text variant='body' tone='secondary' style={{ marginTop: space["2"] }}>
          {t("home.settings.overview.detail")}
        </Text>
      </View>

      <View style={{ marginTop: space["6"] }}>
        <ListGroup title={t("home.settings.scope.legend_title")}>
          {SCOPES.map((scope) => (
            <View
              key={scope}
              style={{
                paddingHorizontal: space["4"],
                paddingVertical: space["3"],
                gap: space["2"],
              }}
            >
              {/* The badge above the sentence rather than beside it: a `Pill`
                  in a row steals width from the text next to it, which at
                  390 px truncated the very sentence explaining it. */}
              <ScopeBadge scope={scope} />
              <Text variant='caption' tone='secondary'>
                {t(`home.settings.scope.${scope}_legend`)}
              </Text>
            </View>
          ))}
        </ListGroup>
      </View>
    </PageContainer>
  );
};
