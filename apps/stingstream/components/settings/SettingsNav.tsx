import { usePathname } from "expo-router";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { Text } from "@/components/common/Text";
import {
  buildSettingsCategories,
  type SettingsCategory,
  settingsNavIntent,
} from "@/components/shell/buildSettingsCategories";
import { SETTINGS_NAV_WIDTH } from "@/constants/Settings";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
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
  const { color } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const user = useAtomValue(userAtom);

  const groups = useMemo(() => buildSettingsCategories(user, t), [user, t]);

  const open = (category: SettingsCategory) => {
    // Which row is *lit* is a prefix match -- `/settings/servers/this` is
    // Servers -- and clicking it used to be answered the same way, so from any
    // drill-in the row that should take you back up was the one dead link on
    // the page. `settingsNavIntent` splits the two questions apart.
    const intent = settingsNavIntent(
      category.route,
      pathname ?? "",
      category.key === activeKey,
    );

    if (intent === "none") return;

    if (intent === "navigate") {
      // Going back up, so `navigate`: it pops to the copy of the category root
      // already below us in the stack instead of stacking a second one, which
      // is what keeps one browser Back press an exit rather than a no-op. It
      // comes off the `...router` spread in `useAppRouter` -- expo-router's
      // own, unwrapped, so the rapid-tap guard on `push` cannot swallow it,
      // and (as with `replace`) a string href gets no `offline=` added.
      router.navigate(category.route as never);
      return;
    }

    // **`replace`, not `push` or `navigate`.** A different category is a
    // sibling of one screen, the way tab roots are, and switching between them
    // is not a journey into anything. `navigate` is no good here either: a
    // sibling is not in the stack, so it would push.
    //
    // Pushing was measurably wrong, not just untidy: walking six categories
    // left six settings screens stacked (confirmed live -- a `settings-nav-*`
    // testID resolved to 1, then 2, then 3... elements in the DOM, one per
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
        borderRightColor: color.border.subtle,
        backgroundColor: color.bg["1"],
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
