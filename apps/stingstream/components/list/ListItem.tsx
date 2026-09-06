import type { PropsWithChildren, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
  Pressable,
  View,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { radius, tokens } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import { Icon, type IconName } from "../common/Icon";
import { Text } from "../common/Text";

interface Props extends ViewProps {
  title?: string | null | undefined;
  subtitle?: string | null | undefined;
  subtitleColor?: "default" | "red";
  value?: string | null | undefined;
  children?: ReactNode;
  iconAfter?: ReactNode;
  icon?: IconName;
  showArrow?: boolean;
  /** `blue` is the legacy name for "this row is an action"; it is the accent. */
  textColor?: "default" | "blue" | "red";
  onPress?: () => void;
  disabled?: boolean;
  disabledByAdmin?: boolean;
}

export const ListItem: React.FC<PropsWithChildren<Props>> = ({
  title,
  subtitle,
  value,
  iconAfter,
  children,
  showArrow = false,
  icon,
  textColor = "default",
  onPress,
  disabled = false,
  disabledByAdmin = false,
  style,
  ...viewProps
}) => {
  const { t } = useTranslation();
  const effectiveSubtitle = disabledByAdmin
    ? t("home.settings.disabled_by_admin")
    : subtitle;
  const isDisabled = disabled || disabledByAdmin;
  const states = usePressableStates({ disabled: isDisabled });

  // Keep the row floor uniform; Android trims padding slightly (its native
  // controls sit taller). Switch height is capped via SettingSwitch so toggle
  // rows match non-toggle rows.
  //
  // A row that cannot be pressed never changes colour: the whole point of the
  // hover and pressed tints is to say "this does something", and a settings row
  // that only holds a switch does not.
  const row: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 44,
    paddingVertical: Platform.OS === "android" ? 6 : 8,
    paddingHorizontal: 16,
    backgroundColor:
      onPress && states.pressed
        ? tokens.color.bg["3"]
        : onPress && states.hovered
          ? tokens.color.bg["2"]
          : tokens.color.bg["1"],
    opacity: isDisabled ? tokens.control.disabledOpacity : 1,
  };

  const content = (
    <ListItemContent
      title={title}
      subtitle={effectiveSubtitle}
      subtitleColor={disabledByAdmin ? "red" : undefined}
      value={value}
      icon={icon}
      textColor={textColor}
      showArrow={showArrow}
      iconAfter={iconAfter}
    >
      {children}
    </ListItemContent>
  );

  if (onPress)
    return (
      <Pressable
        accessibilityRole='button'
        accessibilityState={{ disabled: isDisabled }}
        disabled={isDisabled}
        onPress={onPress}
        {...states.handlers}
        style={[row, states.webStyle, style]}
        {...(viewProps as object)}
      >
        {content}
      </Pressable>
    );

  return (
    <View style={[row, style]} {...viewProps}>
      {content}
    </View>
  );
};

const ListItemContent = ({
  title,
  subtitle,
  subtitleColor,
  textColor,
  icon,
  value,
  showArrow,
  iconAfter,
  children,
}: Props) => {
  const { accent } = useTheme();

  return (
    <>
      <View
        style={{ flexDirection: "row", alignItems: "center", width: "100%" }}
      >
        {icon && (
          <View
            style={{
              borderRadius: radius.sm,
              height: 32,
              width: 32,
              alignItems: "center",
              justifyContent: "center",
              marginRight: 10,
              backgroundColor: tokens.color.bg["3"],
            }}
          >
            <Icon name={icon} size={18} tone='secondary' />
          </View>
        )}
        {/* The label sizes to its content and only shrinks if it alone
            overflows; the value column takes whatever is left. That ordering
            matters — the label used to be `flex-1` with a zero basis, so a long
            value (the dev build string, say) collapsed it to an ellipsis, while
            the value itself had no shrink of its own and ran straight past the
            row to be clipped by the screen edge. */}
        <View style={{ flexShrink: 1 }}>
          <Text
            style={{
              color:
                textColor === "blue"
                  ? accent[500]
                  : textColor === "red"
                    ? tokens.color.state.danger
                    : tokens.color.text.primary,
            }}
            numberOfLines={1}
          >
            {title}
          </Text>
          {subtitle && (
            <Text
              variant='caption'
              tone={subtitleColor === "red" ? "danger" : "secondary"}
              style={{ marginTop: 2 }}
              numberOfLines={2}
            >
              {subtitle}
            </Text>
          )}
        </View>
        {value && (
          // Values here are diagnostics — build string, token, server URL —
          // that are only useful in full, so wrap rather than truncate. The row
          // has a min height, not a fixed one, so it grows to fit.
          <View style={{ flex: 1, alignItems: "flex-end", paddingLeft: 12 }}>
            <Text selectable tone='secondary' align='right'>
              {value}
            </Text>
          </View>
        )}
        {children && <View style={{ marginLeft: "auto" }}>{children}</View>}
        {showArrow && (
          <View style={{ marginLeft: children ? 4 : "auto" }}>
            <Icon name='chevronRight' size={18} tone='tertiary' />
          </View>
        )}
      </View>
      {iconAfter}
    </>
  );
};
