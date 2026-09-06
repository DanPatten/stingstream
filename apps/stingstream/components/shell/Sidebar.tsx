import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
  Pressable,
  ScrollView,
  View,
  type ViewStyle,
} from "react-native";
import { StingStreamMark, StingStreamWordmark } from "@/components/brand";
import { Text } from "@/components/common/Text";
import { radius, tokens, webFocusRing } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type {
  SidebarItem as SidebarItemModel,
  SidebarSection,
} from "./buildSidebarItems";
import { RailTooltip, SidebarItem } from "./SidebarItem";
import { UserMenu } from "./UserMenu";
import { useFocusVisible } from "./useFocusVisible";

/** 240 at `expanded`, a 72 px icon rail at `medium`. */
export const SIDEBAR_WIDTH = 240;
export const SIDEBAR_RAIL_WIDTH = 72;

interface Props {
  sections: SidebarSection[];
  activeKey: string | undefined;
  /** The 72 px rail: glyphs only, labels on hover. */
  collapsed: boolean;
  onSelect: (item: SidebarItemModel) => void;
  onPressBrand: () => void;
}

/**
 * The left column: where everything in the app is.
 *
 * The one structural idea is that *your libraries are navigation*. On a phone
 * they are a screen you open and then pick from; at 1280 px there is room to
 * list them permanently, so "go to Movies" is one click from anywhere instead
 * of three. Everything else — Home above them, the personal and administrative
 * rows below, Settings and the account pinned to the bottom — arranges itself
 * around that.
 */
export const Sidebar: React.FC<Props> = ({
  sections,
  activeKey,
  collapsed,
  onSelect,
  onPressBrand,
}) => {
  const body = sections.filter((section) => section.key !== "footer");
  const footer = sections.filter((section) => section.key === "footer");
  // The rail's hover label. It belongs here, not in the row: the rows sit in a
  // ScrollView, whose overflow clip is 72 px wide, and a tooltip drawn inside
  // it was invisible however far it was offset.
  const [tooltip, setTooltip] = useState<{ label: string; top: number } | null>(
    null,
  );
  const onHoverChange = (label: string | null, top: number) =>
    setTooltip(label ? { label, top } : null);

  return (
    <View
      testID='shell-sidebar'
      role='navigation'
      style={{
        width: collapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_WIDTH,
        backgroundColor: tokens.color.bg["1"],
        borderRightWidth: 1,
        borderRightColor: tokens.color.border.subtle,
      }}
    >
      <BrandButton collapsed={collapsed} onPress={onPressBrand} />

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: collapsed ? 12 : 12,
          paddingBottom: 12,
        }}
        showsVerticalScrollIndicator={false}
      >
        {body.map((section, index) => (
          <View key={section.key} style={{ marginTop: index === 0 ? 0 : 16 }}>
            <SectionLabel title={section.title} collapsed={collapsed} />
            {section.items.map((item) => (
              <SidebarItem
                key={item.key}
                item={item}
                active={item.key === activeKey}
                collapsed={collapsed}
                onPress={() => onSelect(item)}
                onHoverChange={onHoverChange}
              />
            ))}
          </View>
        ))}
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: 12,
          borderTopWidth: 1,
          borderTopColor: tokens.color.border.subtle,
        }}
      >
        {footer.flatMap((section) =>
          section.items.map((item) => (
            <SidebarItem
              key={item.key}
              item={item}
              active={item.key === activeKey}
              collapsed={collapsed}
              onPress={() => onSelect(item)}
              onHoverChange={onHoverChange}
            />
          )),
        )}
        <View style={{ marginTop: 4 }}>
          <UserMenu variant='row' collapsed={collapsed} />
        </View>
      </View>

      {collapsed && tooltip ? (
        <RailTooltip label={tooltip.label} top={tooltip.top + 8} />
      ) : null}
    </View>
  );
};

/**
 * A heading above a group of rows, or a rule when there is no room for words.
 *
 * The rail has 72 px and no label would survive it, but the grouping still
 * needs to read — so the same separation is drawn rather than written.
 */
const SectionLabel: React.FC<{ title?: string; collapsed: boolean }> = ({
  title,
  collapsed,
}) => {
  if (!title) return null;
  if (collapsed) {
    return (
      <View
        style={{
          height: 1,
          marginVertical: 8,
          marginHorizontal: 8,
          backgroundColor: tokens.color.border.subtle,
        }}
      />
    );
  }
  return (
    <Text
      variant='micro'
      tone='tertiary'
      weight='semibold'
      numberOfLines={1}
      style={{
        marginLeft: 14,
        marginBottom: 4,
        textTransform: "uppercase",
        letterSpacing: 0.8,
      }}
    >
      {title}
    </Text>
  );
};

/** The wordmark, which is also the way home. */
const BrandButton: React.FC<{ collapsed: boolean; onPress: () => void }> = ({
  collapsed,
  onPress,
}) => {
  const { t } = useTranslation();
  const { accentName } = useTheme();
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  return (
    <Pressable
      testID='shell-brand'
      accessibilityRole='link'
      accessibilityLabel={t("tabs.home")}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          height: 56,
          alignItems: collapsed ? "center" : "flex-start",
          justifyContent: "center",
          paddingHorizontal: collapsed ? 0 : 18,
          marginBottom: 8,
          borderRadius: radius.sm,
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, accentName) }
            : null),
        } as ViewStyle
      }
    >
      {collapsed ? (
        <StingStreamMark size={28} />
      ) : (
        <StingStreamWordmark height={24} />
      )}
    </Pressable>
  );
};
