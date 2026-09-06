import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useRef, useState } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  type StyleProp,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { motion, radius, resolveTextStyle, tokens } from "@/constants/theme";
import { useBreakpointName } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { FormError } from "./FormError";
import { Icon, type IconName } from "./Icon";

interface InputProps extends Omit<TextInputProps, "style"> {
  /** Legacy: extra classes for the field box. */
  extraClassName?: string;
  /** Applied to the field box, which is what `className` used to reach. */
  style?: StyleProp<ViewStyle>;
  /** A glyph inside the field, before the text. */
  icon?: IconName;
  /**
   * An error message. Renders a `FormError` under the field and turns the rule
   * red — `Alert.alert` shows nothing at all on web, so a form that reports
   * failures any other way is silent in a browser.
   */
  error?: string | null;
}

export function Input(props: InputProps) {
  const {
    style,
    extraClassName = "",
    icon,
    error,
    editable = true,
    ...otherProps
  } = props;
  const inputRef = useRef<TextInput>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const { accent } = useTheme();
  const breakpoint = useBreakpointName();
  // TV-only: scales the input font with the tvTypographyScale setting.
  // Not consumed by the mobile branch below.
  const tvTypography = useScaledTVTypography();

  const animateFocus = (focused: boolean) => {
    Animated.timing(scale, {
      toValue: focused ? 1.02 : 1,
      duration: 150,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  const handleFocus = () => {
    setIsFocused(true);
    animateFocus(true);
  };

  const handleBlur = () => {
    setIsFocused(false);
    animateFocus(false);
  };

  if (Platform.isTV) {
    // Scale the whole input (box height, padding, icon) proportionally with the
    // font so the component grows/shrinks with the tvTypographyScale setting.
    // Uses the `body` token (primary reading size); it resolves to 28 at Default.
    const fontSize = tvTypography.body;
    const factor = fontSize / 28;
    const height = Math.round(56 * factor);
    const paddingLeft = Math.round(24 * factor);
    const iconSize = Math.round(26 * factor);
    const iconMarginRight = Math.round(14 * factor);

    const containerStyle = {
      height,
      borderRadius: 50,
      borderWidth: isFocused ? 1.5 : 1,
      borderColor: isFocused
        ? "rgba(255, 255, 255, 0.3)"
        : "rgba(255, 255, 255, 0.1)",
      overflow: "hidden" as const,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingLeft,
    };

    const inputElement = (
      <>
        <Ionicons
          name='search'
          size={iconSize}
          color={isFocused ? "#999" : "#666"}
          style={{ marginRight: iconMarginRight }}
        />
        <TextInput
          ref={inputRef}
          allowFontScaling={false}
          placeholderTextColor='#666'
          style={{
            flex: 1,
            height,
            fontSize,
            fontWeight: "400",
            color: "#FFFFFF",
            backgroundColor: "transparent",
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          {...otherProps}
        />
      </>
    );

    return (
      <Pressable
        onPress={() => inputRef.current?.focus()}
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        <Animated.View style={{ transform: [{ scale }] }}>
          {Platform.OS === "ios" ? (
            <BlurView
              intensity={isFocused ? 90 : 80}
              tint='dark'
              style={containerStyle}
            >
              {inputElement}
            </BlurView>
          ) : (
            <View
              style={[
                containerStyle,
                {
                  backgroundColor: isFocused
                    ? "rgba(255, 255, 255, 0.12)"
                    : "rgba(255, 255, 255, 0.08)",
                },
              ]}
            >
              {inputElement}
            </View>
          )}
        </Animated.View>
      </Pressable>
    );
  }

  // The rule *is* the focus affordance. An input on bg2 sitting on bg1 is
  // already a distinct shape, so focus brightens its edge rather than adding an
  // outline ring, which would sit outside the rounded rule and read as a second
  // border. Hover is the same idea one step quieter: the pointer is over the
  // field, but the caret is not in it yet.
  //
  //   error > focused > hovered > rest
  //
  // in that order, because an invalid field must stay red while it is being
  // corrected — which is exactly when it is also focused.
  const borderColor = error
    ? tokens.color.state.danger
    : isFocused
      ? accent[400]
      : isHovered && editable
        ? tokens.color.border.strong
        : tokens.color.border.subtle;

  return (
    <View>
      <View
        className={extraClassName}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        style={[
          {
            minHeight: tokens.control.minTouchTarget,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 14,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor,
            backgroundColor:
              isHovered && editable && !isFocused
                ? tokens.color.bg["3"]
                : tokens.color.bg["2"],
            opacity: editable ? 1 : tokens.control.disabledOpacity,
            ...(Platform.OS === "web"
              ? ({
                  cursor: editable ? "text" : "not-allowed",
                  transitionDuration: `${motion.fast}ms`,
                } as object)
              : null),
          },
          style,
        ]}
      >
        {icon ? (
          <Icon
            name={icon}
            size={18}
            tone={isFocused ? "secondary" : "tertiary"}
            style={{ marginRight: 8 }}
          />
        ) : null}
        <TextInput
          ref={inputRef}
          allowFontScaling={false}
          editable={editable}
          placeholderTextColor={tokens.color.text.tertiary}
          clearButtonMode='while-editing'
          onFocus={handleFocus}
          onBlur={handleBlur}
          style={[
            resolveTextStyle("body", "primary", "regular", breakpoint),
            {
              flex: 1,
              paddingVertical: 10,
              // react-native-web draws its own focus ring on a text input,
              // which sits inside the rounded rule and looks like a second
              // border. The rule above is the focus indicator here.
              ...(Platform.OS === "web"
                ? ({ outlineStyle: "none" } as object)
                : null),
            },
          ]}
          {...otherProps}
        />
      </View>
      <FormError message={error} />
    </View>
  );
}
