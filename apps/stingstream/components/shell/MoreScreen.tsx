import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PageContainer } from "@/components/common/PageContainer";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space, tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { userAtom } from "@/providers/JellyfinProvider";
import { useSettings } from "@/utils/atoms/settings";
import { buildMoreItems, type SidebarItem } from "./buildSidebarItems";

/**
 * The fifth tab on a phone.
 *
 * Pass-01 F-08: the bottom bar had grown to seven tabs and truncated every
 * label. Five is the most a 360 dp bar can spell out, so Favorites, Watchlists,
 * Manage, Transfers, Sharing and Settings live here instead — the same rows the
 * desktop sidebar carries, from the same `buildMoreItems` rules, so the two
 * navigators cannot disagree about who sees what.
 *
 * Rows navigate into the *existing* tab groups rather than into copies of their
 * screens: no new route, no second URL for a screen that already has one, and
 * `CLAUDE.test.ts`'s pinned list of tab groups stays exactly as it is. The
 * groups they lead to are hidden from the bar (`tabBarItemHidden`), so they get
 * a chevron back to here — see `useMoreChildScreenOptions` in
 * `components/stacks/NestedTabPageStack.tsx`.
 */
export const MoreScreen: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const user = useAtomValue(userAtom);
  const { settings } = useSettings();
  const insets = useSafeAreaInsets();

  const groups = useMemo(
    () => buildMoreItems(user, settings, t),
    [user, settings, t],
  );

  const open = useCallback(
    (item: SidebarItem) => {
      // `navigate` for every row, where the sidebar honours `item.navigate`:
      // the desktop shell is a single `Stack` of the tab groups and has to
      // replace one with another, but here the navigator *is* a tab navigator,
      // and switching tabs is what `navigate` does. It also reuses a route
      // rather than stacking a second copy, so tapping Favorites twice does not
      // leave two of it behind.
      router.navigate(item.route.pathname as never);
    },
    [router],
  );

  return (
    <ScrollView
      testID='more-screen'
      style={{ flex: 1, backgroundColor: tokens.color.bg["0"] }}
      contentContainerStyle={{
        paddingTop: space["4"],
        // The bottom tab bar floats over the scroll view's last row otherwise.
        paddingBottom: insets.bottom + space["16"],
      }}
    >
      <PageContainer width='settings' style={{ gap: space["6"] }}>
        {groups.map((group) => (
          <ListGroup key={group.key} title={group.title}>
            {group.items.map((item) => (
              <ListItem
                key={item.key}
                testID={item.testID}
                title={item.label}
                // Every row here is a nav row from the semantic registry;
                // library rows (the only `ionicons` ones) are not listed.
                icon={item.icon.set === "semantic" ? item.icon.name : undefined}
                showArrow
                onPress={() => open(item)}
              />
            ))}
          </ListGroup>
        ))}
      </PageContainer>
    </ScrollView>
  );
};

export default MoreScreen;
