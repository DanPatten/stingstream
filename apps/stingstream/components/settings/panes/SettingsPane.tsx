import type { PropsWithChildren, ReactNode } from "react";
import { Platform, View } from "react-native";
import { Text } from "@/components/common/Text";
import { ScreenHeaderRow } from "@/components/stingstream/shared/ScreenHeaderRow";
import { space } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";

/**
 * The top of a settings page: what it is, and what is on it.
 *
 * There used to be a scope badge here — "This device", "Your account", "Whole
 * server" — on the reasoning that nothing otherwise said whether a control
 * changed this browser or every viewer. Dan removed it from Servers first
 * (*"whole server label on Servers is confusing - remove that"*) and then
 * everywhere: *"delete all setting pages badges everywhere"*.
 *
 * It was answering a question the navigation already answers. Settings is
 * grouped into Media, Sharing & access, Server and You, so a page's own group
 * says whose settings it holds — and repeating that as a pill on every page
 * meant fifteen pages carrying a label that only ever said what the heading
 * above it had said. `ScopedBlock` below is what is left of the idea, for the
 * one page that genuinely mixes.
 */
export const SettingsPane: React.FC<
  PropsWithChildren<{
    /** An `home.settings.nav.*` key's value — the category's own label. */
    title: string;
    /** A sentence under the heading, where the title alone is not enough. */
    detail?: string;
    /** Drawn beside the title: a "Save" button, a count, a status pill. */
    accessory?: ReactNode;
  }>
> = ({ title, detail, accessory, children }) => {
  // Below 768 px the screen keeps its own stack header, and that header is
  // already this page's title — so drawing it again put "Profile" twice on a
  // phone, forty pixels apart. Pass-03 F-55 is the same finding at the other
  // width, where the fix was the other way round: the top bar says it once, so
  // the stack header goes. The accessory is not a duplicate of anything and
  // stays at every width.
  const { isWebWide } = useBreakpoint();
  const headerSaysIt = !isWebWide && !Platform.isTV;

  return (
    <View>
      {headerSaysIt ? (
        accessory ? (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "flex-end",
              marginBottom: 12,
            }}
          >
            {accessory}
          </View>
        ) : null
      ) : (
        <ScreenHeaderRow title={title} accessory={accessory} />
      )}
      {detail ? (
        <Text
          variant='caption'
          tone='secondary'
          style={{ marginTop: -4, marginBottom: space["4"] }}
        >
          {detail}
        </Text>
      ) : null}
      {children}
    </View>
  );
};

/**
 * A titled block of rows inside a pane, for the one page that is about two
 * things.
 *
 * Playback is that page: how *this* app plays is a setting for this device, and
 * the server's ceiling on what a remote viewer may pull is not. The heading is
 * what says so now that the badge beside it is gone — which is the part that
 * was doing the work anyway.
 */
export const ScopedBlock: React.FC<PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => (
  <View>
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginLeft: 16,
        marginBottom: 6,
      }}
    >
      <Text
        variant='micro'
        weight='semibold'
        tone='tertiary'
        style={{ textTransform: "uppercase", letterSpacing: 0.6 }}
      >
        {title}
      </Text>
    </View>
    {children}
  </View>
);
