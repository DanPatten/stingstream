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
import { USE_NATIVE_DRIVER } from "@/constants/animation";
import {
  control,
  fade,
  interaction,
  radius,
  rgba,
  type ThemePalette,
} from "@/constants/theme";
import { useHaptic } from "@/hooks/useHaptic";
import { usePressableStates } from "@/hooks/usePressableStates";
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
// variants are mapped back onto its legacy colors below.

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
    minHeight: control.minTouchTarget,
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
  const scale = useRef(new Animated.Value(1)).current;
  // Not `color`: that is this component's own legacy variant prop.
  const { color: palette } = useTheme();
  const lightHapticFeedback = useHaptic("light");
  const resolved = resolveButtonVariant(variant, color);
  // Read before the states hook because the ring colour comes out of it: a
  // filled variant's ring is its own label colour, which is already chosen to
  // be legible on that fill. See `Fill.ring`.
  const fills = FILLS[resolved.variant](palette);
  // `loading` counts as disabled: the press is already in flight, and a button
  // that still lights up under the cursor invites a second one.
  const states = usePressableStates({
    disabled: disabled || loading,
    // An outlined button has no fill for the ring to disappear into.
    ringColor: resolved.outlined ? undefined : fills.ring,
  });

  if (Platform.isTV) {
    const animateTo = (v: number) =>
      Animated.timing(scale, {
        toValue: v,
        duration: 130,
        easing: Easing.out(Easing.quad),
        useNativeDriver: USE_NATIVE_DRIVER,
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
  // "disabled" is not one of the three fills; it is the rest fill faded. Doing
  // it here rather than with an `opacity` on the whole button is what the
  // critique asked for (F-32/F-37): a uniform fade leaves a fully legible
  // label floating on an almost invisible fill, which reads as a link. Fill
  // 35 %, label 60 % keeps the label the more solid of the two, so the control
  // still looks like a button — a switched-off one.
  const paint = isInert
    ? "rest"
    : states.pressed
      ? "pressed"
      : states.hovered
        ? "hovered"
        : "rest";
  const dim = (value: string, alpha: number) =>
    isInert ? fade(value, alpha) : value;

  const fill = resolved.outlined
    ? "transparent"
    : dim(fills[paint], interaction.disabledFillAlpha);
  // Outlined draws the fill as a rule instead: the same color, on the edge.
  // Its label has to leave the filled palette with it, or a dark `onAccent`
  // would be drawn on the page background and disappear.
  const border = dim(
    resolved.outlined ? fills.outline : fills.border,
    interaction.disabledFillAlpha,
  );
  const label = dim(
    resolved.outlined ? fills.outline : fills.label,
    interaction.disabledLabelAlpha,
  );

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: isInert, busy: loading }}
      onPress={() => {
        if (isInert || !onPress) return;
        onPress();
        lightHapticFeedback();
      }}
      {...states.handlers}
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
          // Cursor, transition and the keyboard focus ring. A button that does
          // not say "click me" under the pointer reads as a label.
          ...states.webStyle,
        } as ViewStyle,
        style,
      ]}
      {...props}
    >
      {loading ? (
        // Drawn in the label's own color: the accent default would be
        // invisible on a primary button's accent fill.
        <View className='p-0.5'>
          <Loader color={label} />
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
  /**
   * The focus ring, where the accent one would not be seen.
   *
   * `webFocusRing` draws inside the control, so a primary button's ring lands
   * on the accent fill it is meant to stand out from. Unset means "the accent
   * ring is fine here", which is true of every variant whose rest fill is a
   * neutral surface or nothing at all.
   */
  ring?: string;
}

/**
 * Rest / hover / pressed for each variant, under a given theme.
 *
 * A function of the palette rather than a table of colors, because NativeWind
 * v2 compiles classes once and a module-scope table would bake one theme's
 * answer into the bundle — and a primary button is the most visible place that
 * would go wrong.
 */
const FILLS: Record<ButtonVariant, (palette: ThemePalette) => Fill> = {
  primary: (p) => ({
    rest: p.accent[500],
    hovered: p.accent[400],
    pressed: p.accent[600],
    border: "transparent",
    label: p.accent.onAccent,
    outline: p.accent[400],
    ring: p.accent.onAccent,
  }),
  secondary: (p) => ({
    rest: p.bg["2"],
    hovered: p.bg["3"],
    pressed: p.bg["3"],
    border: p.border.subtle,
    label: p.text.primary,
    outline: p.text.primary,
  }),
  ghost: (p) => ({
    rest: "transparent",
    // The theme's wash, not white: on a light theme a white tint over a white
    // page is no tint at all.
    hovered: rgba(p.overlay, interaction.hoverOverlay),
    pressed: rgba(p.overlay, interaction.pressedOverlay),
    border: "transparent",
    label: p.text.primary,
    outline: p.text.secondary,
  }),
  danger: (p) => ({
    rest: p.state.danger,
    hovered: rgba(p.state.danger, 0.85),
    pressed: rgba(p.state.danger, 0.75),
    border: "transparent",
    // The danger red is a light one on the dark themes, so the label is the
    // page behind it rather than white, which would only reach 3:1.
    label: p.scheme === "dark" ? p.bg["0"] : p.text.primary,
    outline: p.state.danger,
    ring: p.scheme === "dark" ? p.bg["0"] : p.text.primary,
  }),
};
