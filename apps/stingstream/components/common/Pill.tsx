import { type StyleProp, View, type ViewStyle } from "react-native";
import { radius, rgba, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

export type PillTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

export interface PillProps {
  label: string;
  /** What the state *is*. Colour follows from it. */
  tone?: PillTone;
  icon?: IconName;
  /** `soft` is a tinted chip; `solid` is a filled badge for the loud cases. */
  emphasis?: "soft" | "solid";
  size?: "sm" | "md";
  style?: StyleProp<ViewStyle>;
}

/**
 * A small piece of state next to the thing it describes: "Syncing", "4K",
 * "Requested", "Offline".
 *
 * Tinted rather than filled by default — a screen with six saturated badges on
 * it reads as an error page. `solid` exists for the two or three that genuinely
 * need to shout.
 */
export const Pill: React.FC<PillProps> = ({
  label,
  tone = "neutral",
  icon,
  emphasis = "soft",
  size = "md",
  style,
}) => {
  const { accent } = useTheme();
  const base =
    tone === "accent" ? accent[500] : tone === "neutral" ? null : TONES[tone];
  const solid = emphasis === "solid" && base !== null;

  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "flex-start",
          paddingHorizontal: size === "sm" ? 6 : 8,
          paddingVertical: size === "sm" ? 2 : 3,
          borderRadius: radius.pill,
          backgroundColor: solid
            ? base
            : base
              ? rgba(base, 0.16)
              : tokens.color.bg["3"],
        },
        style,
      ]}
    >
      {icon ? (
        <Icon
          name={icon}
          size={size === "sm" ? 11 : 13}
          color={
            solid ? tokens.color.bg["0"] : (base ?? tokens.color.text.secondary)
          }
          style={{ marginRight: 4 }}
        />
      ) : null}
      <Text
        variant={size === "sm" ? "micro" : "caption"}
        weight='semibold'
        style={{
          color: solid
            ? tokens.color.bg["0"]
            : (base ?? tokens.color.text.secondary),
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
};

const TONES: Record<Exclude<PillTone, "neutral" | "accent">, string> = {
  success: tokens.color.state.success,
  warning: tokens.color.state.warning,
  danger: tokens.color.state.danger,
  info: tokens.color.state.info,
};
