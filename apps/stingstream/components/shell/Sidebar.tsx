import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
  Pressable,
  ScrollView,
  View,
  type ViewStyle,
} from "react-native";
import { StingStreamWordmark } from "@/components/brand";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens, webFocusRing } from "@/constants/theme";
import { useFocusVisible } from "@/hooks/useFocusVisible";
import { useTheme } from "@/hooks/useTheme";
import type {
  SidebarItem as SidebarItemModel,
  SidebarSection,
} from "./buildSidebarItems";
import { RailTooltip, SidebarItem } from "./SidebarItem";
import { UserMenu } from "./UserMenu";

/** 240 when the labels are showing, a 72 px icon rail when they are not. */
export const SIDEBAR_WIDTH = 240;
export const SIDEBAR_RAIL_WIDTH = 72;

/** The toggle-and-brand row above the navigation. */
const SIDEBAR_HEADER_HEIGHT = 64;

/** Matches the auth card's lockup at >= 1024 (`components/login/AuthCard.tsx`). */
const SIDEBAR_WORDMARK_HEIGHT = 40;

interface Props {
  sections: SidebarSection[];
  activeKey: string | undefined;
  /** The 72 px rail: glyphs only, labels on hover. */
  collapsed: boolean;
  onSelect: (item: SidebarItemModel) => void;
  onPressBrand: () => void;
  /** Collapse/expand. See `useSidebarCollapsed`. */
  onToggleCollapsed: () => void;
}

/**
 * The left column: where everything in the app is.
 *
 * The one structural idea is that *your libraries are navigation*. On a phone
 * they are a screen you open and then pick from; at 1280 px there is room to
 * list them permanently, so "go to Movies" is one click from anywhere instead
 * of three. Home sits directly above them and Favorites directly below, in the
 * same unlabelled block, because all four are the same act.
 *
 * Below that the column separates rather than groups: a rule marks Requests off
 * as something you *do* rather than something you browse, and an
 * administrator's monitoring rows get the one heading in the whole sidebar.
 * A member sees neither the heading nor the rows — browse and Requests is the
 * whole of their navigation, which is the point. Settings and the account stay
 * pinned to the bottom.
 */
export const Sidebar: React.FC<Props> = ({
  sections,
  activeKey,
  collapsed,
  onSelect,
  onPressBrand,
  onToggleCollapsed,
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
      <SidebarHeader
        collapsed={collapsed}
        onPressBrand={onPressBrand}
        onToggleCollapsed={onToggleCollapsed}
      />

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: collapsed ? 12 : 12,
          paddingBottom: 12,
        }}
        showsVerticalScrollIndicator={false}
      >
        {body.map((section, index) => (
          // A divider brings 8 px of margin of its own, so a section that draws
          // one needs less above it than a titled section does.
          <View
            key={section.key}
            style={{
              marginTop: index === 0 ? 0 : section.divider ? 8 : 16,
            }}
          >
            <SectionLabel
              title={section.title}
              divider={section.divider}
              collapsed={collapsed}
            />
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

/** The rule that stands in for a heading. */
const SectionRule: React.FC = () => (
  <View
    style={{
      height: 1,
      marginVertical: 8,
      marginHorizontal: 8,
      backgroundColor: tokens.color.border.subtle,
    }}
  />
);

/**
 * A heading above a group of rows, or a rule when there is no room for words —
 * or when there is no word worth writing.
 *
 * Three cases. A titled section draws its title, unless the rail has collapsed
 * to 72 px, where no label would survive and the same separation is drawn
 * instead. A section that asks for `divider` draws that rule at every width:
 * Requests is one row whose only honest heading would repeat its own label, and
 * an untitled, undivided section would simply run on from the block above it.
 */
const SectionLabel: React.FC<{
  title?: string;
  divider?: boolean;
  collapsed: boolean;
}> = ({ title, divider, collapsed }) => {
  if (!title) return divider ? <SectionRule /> : null;
  if (collapsed) return <SectionRule />;
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
/**
 * The row above the navigation: collapse, then the brand.
 *
 * The toggle comes first because that is where every application that has one
 * puts it, and because a control that changes the width of the thing it sits in
 * belongs at its edge rather than after the logo. Pass-03 F-70; Dan asked for
 * the Plex shape specifically.
 *
 * On the rail there is room for one 44 px control and nothing else, so the
 * brand steps aside — expanding brings the wordmark straight back, and the mark
 * is still on every compact header and in the tab bar. Trying to fit a 28 px
 * mark and a 44 px button into 72 px of width produced two cramped glyphs and
 * no room for either to breathe.
 */
const SidebarHeader: React.FC<{
  collapsed: boolean;
  onPressBrand: () => void;
  onToggleCollapsed: () => void;
}> = ({ collapsed, onPressBrand, onToggleCollapsed }) => (
  <View
    style={{
      height: SIDEBAR_HEADER_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: collapsed ? "center" : "flex-start",
      paddingHorizontal: collapsed ? 0 : 8,
      gap: 6,
    }}
  >
    <CollapseToggle collapsed={collapsed} onPress={onToggleCollapsed} />
    {collapsed ? null : <BrandButton onPress={onPressBrand} />}
  </View>
);

/** Plex's hamburger: it opens the labels, and the chevron closes them again. */
const CollapseToggle: React.FC<{ collapsed: boolean; onPress: () => void }> = ({
  collapsed,
  onPress,
}) => {
  const { t } = useTranslation();
  const { accentName } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);
  const label = collapsed
    ? t("shell.expand_sidebar")
    : t("shell.collapse_sidebar");

  return (
    <View>
      <Pressable
        testID='shell-sidebar-toggle'
        accessibilityRole='button'
        accessibilityLabel={label}
        accessibilityState={{ expanded: !collapsed }}
        onPress={onPress}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={
          {
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: radius.sm,
            backgroundColor: hovered ? tokens.color.bg["3"] : "transparent",
            ...(Platform.OS === "web"
              ? { cursor: "pointer", ...webFocusRing(showRing, accentName) }
              : null),
          } as ViewStyle
        }
      >
        {/*
          A hamburger in both states, not a direction-aware chevron: it is what
          the control is, and what people reach for. The chevron was only ever a
          stand-in for a glyph the icon registry did not have.
        */}
        <Icon name='menu' size={20} color={tokens.color.text.secondary} />
      </Pressable>
      {/* The rail has no labels at all, so the toggle needs the same hover
          explanation every row there gets. */}
      {collapsed && hovered ? <RailTooltip label={label} top={8} /> : null}
    </View>
  );
};

/**
 * The wordmark, and a way home.
 *
 * 40 px tall to match the sign-in card's lockup: at 24 the mark was 19 px of
 * ink on a 1440 px screen and read as a favicon somebody had left in the
 * corner (pass-03 F-54). The lockup carries its own 14 % margin, so the padding
 * here is what puts its ink on the same left edge as the row glyphs below it.
 */
const BrandButton: React.FC<{ onPress: () => void }> = ({ onPress }) => {
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
          height: SIDEBAR_HEADER_HEIGHT - 8,
          justifyContent: "center",
          paddingHorizontal: 4,
          borderRadius: radius.sm,
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, accentName) }
            : null),
        } as ViewStyle
      }
    >
      <StingStreamWordmark height={SIDEBAR_WORDMARK_HEIGHT} />
    </Pressable>
  );
};
