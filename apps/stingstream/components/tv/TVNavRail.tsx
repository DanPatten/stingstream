import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  Animated,
  Easing,
  Pressable,
  type StyleProp,
  TVFocusGuideView,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StingStreamMark } from "@/components/brand";
import { Icon, type IconName } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { useTVFocusAnimation } from "@/components/tv/hooks/useTVFocusAnimation";
import { TV_FOCUS, useScaledTVCardLayout } from "@/constants/TVCardLayouts";
import { TVAnimation, useScaledTVSizes } from "@/constants/TVSizes";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { scaleSize } from "@/utils/scaleSize";

export interface TVNavRailItem {
  /** The tab group this item selects, e.g. `(home)`. */
  key: string;
  label: string;
  icon: IconName;
}

export interface TVNavRailProps {
  items: TVNavRailItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  /** Initials for the account button at the foot of the rail. */
  accountInitials?: string;
  /** Account name, for the label the expanded rail shows. */
  accountLabel?: string;
  /** Opens the user switch modal. Omit and the account button is not rendered. */
  onAccountPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

/** White at rest is too loud for seven icons at once; 70% reads as "available". */
const IDLE_ICON = "rgba(255,255,255,0.7)";
const LABEL_IDLE = "rgba(255,255,255,0.75)";

interface RailRowProps {
  label: string;
  icon: IconName;
  active: boolean;
  /** 0 collapsed, 1 expanded. Drives the label fade. */
  expand: Animated.Value;
  onSelect: () => void;
  onFocusChange: (focused: boolean) => void;
}

/**
 * One rail row.
 *
 * The Pressable is exactly the collapsed rail wide, and the label is an
 * absolutely positioned sibling that overflows it. That is deliberate: on
 * Android TV, focus search uses a view's layout bounds, so a row laid out at
 * the *expanded* width would keep a 288 px focus rectangle even while it looks
 * 96 px wide — and RIGHT out of the rail would land back inside the rail
 * instead of on the content. Keeping the focusable box collapsed keeps the
 * geometry honest, and the expansion is purely paint.
 */
const RailRow: React.FC<RailRowProps> = ({
  label,
  icon,
  active,
  expand,
  onSelect,
  onFocusChange,
}) => {
  const typography = useScaledTVTypography();
  const sizes = useScaledTVSizes();
  const railCard = useScaledTVCardLayout("rail");
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({
      onFocus: () => onFocusChange(true),
      onBlur: () => onFocusChange(false),
    });

  const wellSize = Math.round(railCard.cardWidth * 0.66);
  const iconColor = focused ? "#000000" : active ? "#FFFFFF" : IDLE_ICON;

  return (
    <Pressable
      onPress={onSelect}
      onFocus={handleFocus}
      onBlur={handleBlur}
      // Rail items never take the initial focus: content owns it, so the first
      // thing a viewer sees selected is a poster, not a menu entry.
      hasTVPreferredFocus={false}
      style={{
        width: sizes.layout.railCollapsedWidth,
        height: railCard.cardWidth,
        justifyContent: "center",
      }}
    >
      {/* Active marker: a 4 px bar hard against the screen edge. */}
      <View
        style={{
          position: "absolute",
          left: 0,
          top: "25%",
          bottom: "25%",
          width: scaleSize(4),
          borderRadius: scaleSize(2),
          backgroundColor: active ? "#FFFFFF" : "transparent",
        }}
      />

      <Animated.View
        style={[
          animatedStyle,
          {
            width: wellSize,
            height: wellSize,
            borderRadius: railCard.borderRadius,
            alignSelf: "center",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: focused ? TV_FOCUS.borderColor : "transparent",
          },
        ]}
      >
        <Icon name={icon} size={Math.round(wellSize * 0.5)} color={iconColor} />
      </Animated.View>

      <Animated.View
        pointerEvents='none'
        style={{
          position: "absolute",
          left: sizes.layout.railCollapsedWidth,
          right: -(
            sizes.layout.railExpandedWidth - sizes.layout.railCollapsedWidth
          ),
          opacity: expand,
          justifyContent: "center",
          top: 0,
          bottom: 0,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            fontSize: typography.body,
            color: active || focused ? "#FFFFFF" : LABEL_IDLE,
            fontWeight: active ? "600" : "400",
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
};

/** The account button wants the same focus treatment as a row, not a new one. */
const useAccountFocus = (onFocusChange: (focused: boolean) => void) => {
  const { focused, handleFocus, handleBlur, animatedStyle } =
    useTVFocusAnimation({
      onFocus: () => onFocusChange(true),
      onBlur: () => onFocusChange(false),
    });

  return {
    accountFocused: focused,
    handleAccountFocus: handleFocus,
    handleAccountBlur: handleBlur,
    accountAnimatedStyle: animatedStyle,
  };
};

/**
 * The left navigation rail.
 *
 * It replaces the horizontal tab bar the TV build used to wear across the top,
 * which cost a whole row of vertical space on every screen and put the tabs
 * where a viewer's thumb never goes. The rail is an absolute overlay pinned to
 * the left edge — screens do not lose layout width to it, they owe it
 * `TVLayout.contentInsetLeft` of left padding — and it widens from 96 to 288 as
 * soon as anything inside it takes focus, revealing the labels.
 *
 * Focus rules, all of them load bearing:
 *
 * - No row carries `hasTVPreferredFocus`. Content keeps the initial focus on
 *   every screen, so the rail is somewhere you go, not somewhere you land.
 * - `trapFocusUp` / `trapFocusDown` keep UP and DOWN inside the rail column:
 *   without them, UP from the first item escapes into whatever content happens
 *   to be painted behind the rail.
 * - LEFT and RIGHT are deliberately *not* trapped. LEFT from the leftmost
 *   content column lands here geometrically, and RIGHT goes back the same way,
 *   because every screen's content starts clear of the collapsed rail.
 */
export const TVNavRail: React.FC<TVNavRailProps> = ({
  items,
  activeKey,
  onSelect,
  accountInitials,
  accountLabel,
  onAccountPress,
  style,
}) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const sizes = useScaledTVSizes();
  const typography = useScaledTVTypography();
  const railCard = useScaledTVCardLayout("rail");

  // One value drives the width, the panel and every label, so the rail cannot
  // half-expand. Width is not a native-driver property, hence JS-driven.
  const expand = React.useRef(new Animated.Value(0)).current;
  const focusedCount = React.useRef(0);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    Animated.timing(expand, {
      toValue: expanded ? 1 : 0,
      duration: TVAnimation.railExpandMs,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [expanded, expand]);

  /**
   * Focus moving between two rail rows fires blur-then-focus, so a naive
   * boolean would collapse and re-expand the rail on every D-pad press. Count
   * instead, and only collapse when nothing in the rail holds focus.
   */
  const handleFocusChange = React.useCallback((isFocused: boolean) => {
    focusedCount.current = Math.max(
      0,
      focusedCount.current + (isFocused ? 1 : -1),
    );
    setExpanded(focusedCount.current > 0);
  }, []);

  const {
    accountFocused,
    handleAccountFocus,
    handleAccountBlur,
    accountAnimatedStyle,
  } = useAccountFocus(handleFocusChange);

  const panelWidth = expand.interpolate({
    inputRange: [0, 1],
    outputRange: [
      sizes.layout.railCollapsedWidth,
      sizes.layout.railExpandedWidth,
    ],
  });

  const wellSize = Math.round(railCard.cardWidth * 0.66);

  if (items.length === 0) return null;

  return (
    <View
      // box-none so the scrim and the empty column below the items do not eat
      // presses meant for the content painted underneath.
      pointerEvents='box-none'
      style={[
        {
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: sizes.layout.railExpandedWidth,
        },
        style,
      ]}
    >
      {/* Always-on scrim: the collapsed icons sit over posters and need it. */}
      <LinearGradient
        pointerEvents='none'
        colors={["rgba(0,0,0,0.85)", "transparent"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: sizes.layout.railScrimWidth,
        }}
      />

      {/* Solid panel, revealed as the rail expands, so labels have a ground. */}
      <Animated.View
        pointerEvents='none'
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: panelWidth,
          backgroundColor: "rgba(0,0,0,0.85)",
          opacity: expand,
        }}
      />

      <TVFocusGuideView
        trapFocusUp
        trapFocusDown
        style={{
          width: sizes.layout.railCollapsedWidth,
          flex: 1,
          paddingTop: insets.top + sizes.gaps.section,
          paddingBottom: insets.bottom + sizes.gaps.section,
          alignItems: "flex-start",
        }}
      >
        {/* Mark. Mono white: the rail is chrome, and the teal gradient over a
            poster reads as a badge stuck to the screen. */}
        <View
          style={{
            width: sizes.layout.railCollapsedWidth,
            alignItems: "center",
            marginBottom: sizes.gaps.large,
          }}
        >
          <StingStreamMark
            size={Math.round(railCard.cardWidth * 0.42)}
            color='#FFFFFF'
            variant='mono'
          />
        </View>

        <View style={{ flex: 1 }}>
          {items.map((item) => (
            <RailRow
              key={item.key}
              label={item.label}
              icon={item.icon}
              active={item.key === activeKey}
              expand={expand}
              onSelect={() => onSelect(item.key)}
              onFocusChange={handleFocusChange}
            />
          ))}
        </View>

        {onAccountPress && (
          <Pressable
            onPress={onAccountPress}
            onFocus={handleAccountFocus}
            onBlur={handleAccountBlur}
            hasTVPreferredFocus={false}
            style={{
              width: sizes.layout.railCollapsedWidth,
              height: railCard.cardWidth,
              justifyContent: "center",
            }}
          >
            <Animated.View
              style={[
                accountAnimatedStyle,
                {
                  width: wellSize,
                  height: wellSize,
                  borderRadius: wellSize / 2,
                  alignSelf: "center",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: accountFocused
                    ? TV_FOCUS.borderColor
                    : "rgba(255,255,255,0.15)",
                },
              ]}
            >
              <Text
                style={{
                  fontSize: typography.callout,
                  fontWeight: "700",
                  color: accountFocused ? "#000000" : "#FFFFFF",
                }}
              >
                {accountInitials || "?"}
              </Text>
            </Animated.View>

            <Animated.View
              pointerEvents='none'
              style={{
                position: "absolute",
                left: sizes.layout.railCollapsedWidth,
                right: -(
                  sizes.layout.railExpandedWidth -
                  sizes.layout.railCollapsedWidth
                ),
                top: 0,
                bottom: 0,
                justifyContent: "center",
                opacity: expand,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  fontSize: typography.body,
                  color: accountFocused ? "#FFFFFF" : LABEL_IDLE,
                }}
              >
                {accountLabel || t("tv.nav.account")}
              </Text>
            </Animated.View>
          </Pressable>
        )}
      </TVFocusGuideView>
    </View>
  );
};
