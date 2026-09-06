import type React from "react";
import {
  type PropsWithChildren,
  type ReactNode,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  Text as RNText,
  type StyleProp,
  type TouchableOpacityProps,
  View,
  type ViewStyle,
} from "react-native";
import { Icon, type IconName } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import {
  type AccentPalette,
  motion,
  radius,
  rgba,
  tokens,
  webFocusRing,
} from "@/constants/theme";
import { useHaptic } from "@/hooks/useHaptic";
import { useTheme } from "@/hooks/useTheme";
import { scaleSize } from "@/utils/scaleSize";
import { Loader } from "./Loader";

// ---------------------------------------------------------------------------
// TV: unchanged
// ---------------------------------------------------------------------------
//
// The 10-foot button is its own thing — white focus ring, focus scale, no
// accent (`docs/conventions/tv.md`) — and it is driven by D-pad focus rather
// than hover and pressed states. It is left exactly as it was, and the new
// variants are mapped back onto its legacy colours below.

const getColorClasses = (
  color: LegacyColor,
  variant: "solid" | "border",
  focused: boolean,
): string => {
  if (variant === "border") {
    switch (color) {
      case "purple":
        return focused
          ? "bg-transparent border-2 border-purple-400"
          : "bg-transparent border-2 border-purple-600";
      case "red":
        return focused
          ? "bg-transparent border-2 border-red-400"
          : "bg-transparent border-2 border-red-600";
      case "black":
        return focused
          ? "bg-transparent border-2 border-neutral-700"
          : "bg-transparent border-2 border-neutral-900";
      case "white":
        return focused
          ? "bg-transparent border-2 border-gray-100"
          : "bg-transparent border-2 border-white";
      case "transparent":
        return focused
          ? "bg-transparent border-2 border-gray-400"
          : "bg-transparent border-2 border-gray-600";
      default:
        return "";
    }
  }
  switch (color) {
    case "purple":
      return focused
        ? "bg-purple-500 border-2 border-white"
        : "bg-purple-600 border border-purple-700";
    case "red":
      return "bg-red-600";
    case "black":
      return "bg-neutral-900";
    case "white":
      return focused
        ? "bg-gray-100 border-2 border-gray-300"
        : "bg-white border border-gray-200";
    case "transparent":
      return "bg-transparent";
    default:
      return "";
  }
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/** Streamyfin's palette prop. Kept so the ~45 call sites still compile. */
export type LegacyColor = "purple" | "red" | "black" | "transparent" | "white";

/** Streamyfin's fill prop. `border` survives as an outlined treatment. */
type LegacyVariant = "solid" | "border";

/**
 * The legacy palette onto the new variants.
 *
 * `purple` was the old accent, so it becomes the new one. `black` and `white`
 * were both "the other button in the row", which is what `secondary` is now.
 */
const LEGACY_COLORS: Record<LegacyColor, ButtonVariant> = {
  purple: "primary",
  black: "secondary",
  white: "secondary",
  red: "danger",
  transparent: "ghost",
};

/** ...and back again, for the TV branch, which still speaks the old language. */
const TV_COLORS: Record<ButtonVariant, LegacyColor> = {
  primary: "purple",
  secondary: "black",
  ghost: "transparent",
  danger: "red",
};

/**
 * Still based on `TouchableOpacity`'s props even though the button now renders
 * a `Pressable`.
 *
 * `PressableProps` widens several handlers to `| null`, and
 * `components/PlayButton.tv.tsx` spreads `ComponentProps<typeof Button>`
 * straight onto a `TouchableOpacity`, which does not accept them — so the
 * public shape stays the narrower of the two. The extra props a `Pressable`
 * understands (`onHoverIn`, `onPressIn`, ...) are set here, not passed in.
 */
export interface ButtonProps
  extends Omit<TouchableOpacityProps, "children" | "style"> {
  onPress?: () => void;
  className?: string;
  textClassName?: string;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  children?: string | ReactNode;
  loading?: boolean;
  /**
   * `primary` | `secondary` | `ghost` | `danger`, or one of the two legacy
   * values. `solid` means "read the fill from `color`"; `border` outlines the
   * variant instead of filling it.
   */
  variant?: ButtonVariant | LegacyVariant;
  /** Legacy. Prefer `variant`, which wins if both are given. */
  color?: LegacyColor;
  size?: ButtonSize;
  /** A semantic icon before the label — the common case. */
  icon?: IconName;
  /** Arbitrary nodes either side, when `icon` is not enough. */
  iconRight?: ReactNode;
  iconLeft?: ReactNode;
  justify?: "center" | "between";
}

const isNewVariant = (value: ButtonProps["variant"]): value is ButtonVariant =>
  value === "primary" ||
  value === "secondary" ||
  value === "ghost" ||
  value === "danger";

/** What the caller asked for, whichever vocabulary they used. */
export const resolveButtonVariant = (
  variant: ButtonProps["variant"],
  color: LegacyColor | undefined,
): { variant: ButtonVariant; outlined: boolean } => {
  if (isNewVariant(variant)) return { variant, outlined: false };
  return {
    variant: color ? LEGACY_COLORS[color] : "primary",
    outlined: variant === "border",
  };
};

const SIZES: Record<
  ButtonSize,
  { minHeight: number; paddingH: number; gap: number; icon: number }
> = {
  // 44 is the minimum touch target; `sm` is 40 because it only ever appears
  // inside a row that is itself at least 44 tall.
  sm: { minHeight: 40, paddingH: 12, gap: 6, icon: 16 },
  md: {
    minHeight: tokens.control.minTouchTarget,
    paddingH: 16,
    gap: 8,
    icon: 18,
  },
  lg: { minHeight: 52, paddingH: 20, gap: 8, icon: 20 },
};

// ---------------------------------------------------------------------------

export const Button: React.FC<PropsWithChildren<ButtonProps>> = ({
  onPress,
  className: _className,
  textClassName = "",
  style,
  disabled = false,
  loading = false,
  color,
  variant,
  size = "md",
  icon,
  iconRight,
  iconLeft,
  children,
  justify = "center",
  ...props
}) => {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const { accent, accentName } = useTheme();
  const lightHapticFeedback = useHaptic("light");
  const resolved = resolveButtonVariant(variant, color);

  if (Platform.isTV) {
    const animateTo = (v: number) =>
      Animated.timing(scale, {
        toValue: v,
        duration: 130,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    const colorClasses = getColorClasses(
      color ?? TV_COLORS[resolved.variant],
      resolved.outlined ? "border" : "solid",
      focused,
    );
    const textColorClass =
      color === "white" && !resolved.outlined ? "text-black" : "text-white";

    return (
      <Pressable
        className='w-full'
        onPress={onPress}
        onFocus={() => {
          setFocused(true);
          animateTo(1.03);
        }}
        onBlur={() => {
          setFocused(false);
          animateTo(1);
        }}
      >
        <Animated.View
          style={{
            transform: [{ scale }],
            shadowColor: "#ffffff",
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: focused ? 0.5 : 0,
            shadowRadius: focused ? scaleSize(10) : 0,
            elevation: focused ? 12 : 0, // Android glow
          }}
        >
          <View
            style={{
              borderRadius: scaleSize(16),
              paddingVertical: scaleSize(14),
              alignItems: "center",
              justifyContent: "center",
            }}
            className={`${colorClasses} ${_className ?? ""}`}
          >
            <RNText
              style={{ fontSize: scaleSize(20), fontWeight: "bold" }}
              className={textColorClass}
            >
              {children}
            </RNText>
          </View>
        </Animated.View>
      </Pressable>
    );
  }

  const metrics = SIZES[size];
  const isInert = disabled || loading;
  const state = pressed ? "pressed" : hovered ? "hovered" : "rest";
  const fills = FILLS[resolved.variant](accent);
  const fill = resolved.outlined ? "transparent" : fills[state];
  // Outlined draws the fill as a rule instead: the same colour, on the edge.
  // Its label has to leave the filled palette with it, or a dark `onAccent`
  // would be drawn on the page background and disappear.
  const border = resolved.outlined ? fills.outline : fills.border;
  const label = resolved.outlined ? fills.outline : fills.label;

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: isInert, busy: loading }}
      onPress={() => {
        if (isInert || !onPress) return;
        onPress();
        lightHapticFeedback();
      }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      disabled={isInert}
      style={[
        {
          minHeight: metrics.minHeight,
          paddingHorizontal: metrics.paddingH,
          paddingVertical: 8,
          borderRadius: radius.md,
          borderWidth: border === "transparent" ? 0 : resolved.outlined ? 2 : 1,
          borderColor: border,
          backgroundColor: fill,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: justify === "between" ? "space-between" : "center",
          opacity: isInert ? tokens.control.disabledOpacity : 1,
          ...(Platform.OS === "web"
            ? {
                // A button that does not say "click me" under the cursor reads
                // as a label. `transitionDuration` is web-only and ignored by
                // the native renderers.
                cursor: isInert ? "not-allowed" : "pointer",
                transitionDuration: `${motion.fast}ms`,
                ...webFocusRing(focused, accentName),
              }
            : null),
        } as ViewStyle,
        style,
      ]}
      {...props}
    >
      {loading ? (
        <View className='p-0.5'>
          <Loader />
        </View>
      ) : (
        <>
          {iconLeft}
          {icon ? (
            <Icon
              name={icon}
              size={metrics.icon}
              color={label}
              style={{ marginRight: children ? metrics.gap : 0 }}
            />
          ) : null}
          {typeof children === "string" ? (
            <Text
              variant={size === "sm" ? "caption" : "body"}
              weight='semibold'
              className={textClassName}
              style={{ color: label }}
              numberOfLines={1}
            >
              {children}
            </Text>
          ) : (
            children
          )}
          {iconRight}
        </>
      )}
    </Pressable>
  );
};

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

interface Fill {
  rest: string;
  hovered: string;
  pressed: string;
  /** The rule around a filled button; usually none. */
  border: string;
  /** Label and icon on the fill. */
  label: string;
  /** Rule and label when the button is outlined rather than filled. */
  outline: string;
}

/**
 * Rest / hover / pressed for each variant.
 *
 * The accent shades come from `useTheme()` rather than from a class, because
 * NativeWind v2 compiles classes once and cannot follow a runtime accent — and
 * a primary button is the most visible place that matters.
 */
const FILLS: Record<ButtonVariant, (accent: AccentPalette) => Fill> = {
  primary: (a) => ({
    rest: a[500],
    hovered: a[400],
    pressed: a[600],
    border: "transparent",
    label: a.onAccent,
    outline: a[400],
  }),
  secondary: () => ({
    rest: tokens.color.bg["2"],
    hovered: tokens.color.bg["3"],
    pressed: tokens.color.bg["3"],
    border: tokens.color.border.subtle,
    label: tokens.color.text.primary,
    outline: tokens.color.text.primary,
  }),
  ghost: () => ({
    rest: "transparent",
    hovered: rgba("#FFFFFF", 0.06),
    pressed: rgba("#FFFFFF", 0.1),
    border: "transparent",
    label: tokens.color.text.primary,
    outline: tokens.color.text.secondary,
  }),
  danger: () => ({
    rest: tokens.color.state.danger,
    hovered: rgba(tokens.color.state.danger, 0.85),
    pressed: rgba(tokens.color.state.danger, 0.75),
    border: "transparent",
    // #FF5C5C is a light red: white on it is 3:1, the darkest surface 6.5:1.
    label: tokens.color.bg["0"],
    outline: tokens.color.state.danger,
  }),
};
