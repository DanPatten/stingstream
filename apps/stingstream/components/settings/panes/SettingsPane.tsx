import type { PropsWithChildren, ReactNode } from "react";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import type { SettingsScope } from "@/components/shell/buildSettingsCategories";
import { ScreenHeaderRow } from "@/components/stingstream/shared/ScreenHeaderRow";
import { space } from "@/constants/theme";
import { ScopeBadge } from "../ScopeBadge";

/**
 * The top of a settings page: what it is, and who it is for.
 *
 * Every pane opens the same way, and the badge is the reason this exists rather
 * than each page drawing its own heading. Nothing on the old Settings screen
 * said whether a control changed this browser or every viewer on the server,
 * and the two most confusable controls in the app — a viewer's own playback
 * quality and the server's remote bitrate ceiling — read almost identically
 * without it.
 *
 * The badge goes in `ScreenHeaderRow`'s `accessory` slot, never into a
 * `ListItem`: a `Pill` inside a row steals width from the row's own title, and
 * at 390 px it truncated it.
 */
export const SettingsPane: React.FC<
  PropsWithChildren<{
    /** An `home.settings.nav.*` key's value — the category's own label. */
    title: string;
    scope: SettingsScope;
    /** A sentence under the heading, where the title alone is not enough. */
    detail?: string;
    /** Drawn beside the badge: a "Save" button, a count, a status pill. */
    accessory?: ReactNode;
  }>
> = ({ title, scope, detail, accessory, children }) => (
  <View>
    <ScreenHeaderRow
      title={title}
      accessory={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {accessory}
          <ScopeBadge scope={scope} />
        </View>
      }
    />
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

/**
 * A block of rows inside a pane whose scope is not the pane's.
 *
 * Rare, and deliberately so — a page that mixes scopes is a page that is about
 * two things. Playback is the one that genuinely does: how *this* app plays is
 * a device setting, and the server's ceiling on what a remote viewer may pull
 * is not.
 */
export const ScopedBlock: React.FC<
  PropsWithChildren<{ title: string; scope: SettingsScope }>
> = ({ title, scope, children }) => (
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
      <ScopeBadge scope={scope} />
    </View>
    {children}
  </View>
);
