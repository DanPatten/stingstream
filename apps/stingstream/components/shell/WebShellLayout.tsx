import type { PropsWithChildren } from "react";
import { View } from "react-native";
import { CastControlsSheet } from "@/components/cast/CastControlsSheet";
import { useTheme } from "@/hooks/useTheme";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { useShellNavigation } from "./useShellNavigation";
import { useSidebarCollapsed } from "./useSidebarCollapsed";

/**
 * The desktop chrome: a sidebar and a top bar around the tab navigator.
 *
 * **It wraps the navigator; it is not one.** The first version of this replaced
 * the bottom-tab navigator with a `Stack` above 768 px, which meant dragging a
 * window across that width handed a Stack's navigation state to a TabRouter (or
 * the other way round) — and react-navigation reads fields off it that the
 * other kind has never had. The app did not just lose its place: it rendered
 * "Something went wrong". So there is one navigator at every width now, the
 * same one, and crossing the breakpoint changes nothing but the furniture: the
 * bottom bar goes, the sidebar and top bar arrive, and the tab you were on and
 * the page you were on both survive.
 *
 * Everything it needs comes from `useShellNavigation`, which works it out from
 * the route, so it holds no navigation state of its own and can be mounted and
 * unmounted freely. Below 768 px the same rows are the drawer the tab bar's
 * hamburger opens — see `MobileShell`.
 */
export const WebShellLayout: React.FC<PropsWithChildren> = ({ children }) => {
  const { color } = useTheme();
  const { collapsed, toggle } = useSidebarCollapsed();
  const { sections, activeKey, pageTitle, goHome, onSelect } =
    useShellNavigation();

  return (
    <View
      style={{
        flex: 1,
        flexDirection: "row",
        backgroundColor: color.bg["0"],
      }}
    >
      <Sidebar
        sections={sections}
        activeKey={activeKey}
        collapsed={collapsed}
        onSelect={onSelect}
        onPressBrand={goHome}
        onToggleCollapsed={toggle}
      />
      {/* `minWidth: 0` or a wide child (a poster row, a table) pushes the
          column out instead of scrolling inside it, and the page grows a
          horizontal scrollbar. */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <TopBar fallbackTitle={pageTitle} />
        {children}
      </View>
      <CastControlsSheet />
    </View>
  );
};

export default WebShellLayout;
