import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { Text } from "@/components/common/Text";
import {
  buildSettingsCategories,
  type SettingsCategory,
} from "@/components/shell/buildSettingsCategories";
import { SETTINGS_NAV_WIDTH } from "@/constants/Settings";
import { tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { userAtom } from "@/providers/JellyfinProvider";
import { SettingsNavItem } from "./SettingsNavItem";

/**
 * The category column: the master half of the master-detail.
 *
 * It is a list of links, not a navigator. The one structural rule the shell
 * lives by is that there is exactly one navigator at every width
 * (`WebShellLayout`'s docblock records what happened when there were two), so
 * this navigates the same `Stack` every other row in the app does and gets
 * re-mounted on each move. That is cheap: `buildSettingsCategories` is pure,
 * takes two arguments, and the column holds no state worth preserving.
 */
export const SettingsNav: React.FC<{
  /** The category currently showing, from `categoryForRoute`. */
  activeKey?: string;
}> = ({ activeKey }) => {
  const { t } = useTranslation();
  const router = useRouter();
  const user = useAtomValue(userAtom);

  const groups = useMemo(() => buildSettingsCategories(user, t), [user, t]);

  const open = (category: SettingsCategory) => {
    if (category.key === activeKey) return;
    // **`replace`, not `push` or `navigate`.** Categories are siblings of one
    // screen, the way tab roots are, and switching between them is not a
    // journey into anything — the sidebar replaces for the same reason.
    //
    // Pushing was measurably wrong, not just untidy: walking six categories
    // left six settings screens stacked (confirmed live — a `settings-nav-*`
    // testID resolved to 1, then 2, then 3… elements in the DOM, one per
    // still-mounted screen underneath), six copies of this column with them,
    // and six presses of the browser's back button between the reader and
    // wherever they came from. Dan reported it as the address bar not keeping
    // up; it was the stack growing under it.
    router.replace(category.route as never);
  };

  return (
    <View
      testID='settings-nav'
      role='navigation'
      style={{
        width: SETTINGS_NAV_WIDTH,
        borderRightWidth: 1,
        borderRightColor: tokens.color.border.subtle,
        backgroundColor: tokens.color.bg["1"],
      }}
    >
      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {groups.map((group, index) => (
          <View
            key={group.key}
            testID={group.testID}
            style={{ marginTop: index === 0 ? 0 : 20 }}
          >
            <Text
              variant='micro'
              tone='tertiary'
              weight='semibold'
              numberOfLines={1}
              style={{
                marginLeft: 12,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              {group.title}
            </Text>
            {group.categories.map((category) => (
              <SettingsNavItem
                key={category.key}
                category={category}
                active={category.key === activeKey}
                onPress={() => open(category)}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
};
