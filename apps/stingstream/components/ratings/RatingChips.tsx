import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Linking,
  Platform,
  Pressable,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  RATING_CHIP_GEOMETRY,
  RATING_STAR_COLOR,
  type RatingChipSize,
  type RatingScores,
  visibleRatings,
} from "./ratingScores";

const isWeb = Platform.OS === "web";

/**
 * A title's scores as quiet chips: a gold star with the community score, a tomato with the critics'
 * percentage. The one way a score is drawn, in the library and in Requests alike.
 *
 * A score that does not exist is not drawn, and with neither this renders nothing, so a caller
 * wrapping it in spacing should check `hasRatings` first.
 *
 * Text by default. Pass `links` and each chip becomes a way out to the page its score came from,
 * which the request sheet does and a tile does not. Dan: *"Linkable on modal only."*
 */
export function RatingChips({
  size = "caption",
  links,
  style,
  ...scores
}: RatingScores & {
  size?: RatingChipSize;
  links?: { community?: string; critics?: string };
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const shown = visibleRatings(scores);
  if (shown.community === null && shown.critics === null) return null;

  const { glyph, gap } = RATING_CHIP_GEOMETRY[size];

  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          // A tile is sized before it is measured, so under a poster the line never wraps.
          flexWrap: size === "micro" ? "nowrap" : "wrap",
          gap,
        },
        style,
      ]}
    >
      {shown.community !== null ? (
        <RatingChip
          size={size}
          href={links?.community}
          label={shown.community}
          accessibilityLabel={t("ratings.community", {
            score: shown.community,
          })}
          icon={<Ionicons name='star' size={glyph} color={RATING_STAR_COLOR} />}
        />
      ) : null}
      {shown.critics !== null ? (
        <RatingChip
          size={size}
          href={links?.critics}
          label={`${shown.critics.score}%`}
          accessibilityLabel={t("ratings.critics", {
            score: shown.critics.score,
          })}
          icon={
            <Image
              source={
                shown.critics.fresh
                  ? require("@/assets/images/rt_fresh.svg")
                  : require("@/assets/images/rt_rotten.svg")
              }
              style={{ width: glyph, height: glyph }}
            />
          }
        />
      ) : null}
    </View>
  );
}

/**
 * One chip: a glyph and a short label on `bg3`. Exported for the details page's age rating, which
 * sits in the same line and should look like it belongs there.
 *
 * Not `Pill`: `Pill`'s icon slot only takes a name from the semantic registry, and there is no
 * Ionicon for Rotten Tomatoes and there should not be one.
 */
export function RatingChip({
  label,
  icon,
  accessibilityLabel,
  href,
  size = "caption",
}: {
  label: string;
  icon?: ReactNode;
  accessibilityLabel?: string;
  href?: string;
  size?: RatingChipSize;
}) {
  const { color } = useTheme();
  // `hovered` is absent from `PressableStateCallbackType` in these typings even though
  // react-native-web passes it, so it is held here, as `Button` does.
  const [hovered, setHovered] = useState(false);
  const { paddingHorizontal, paddingVertical } = RATING_CHIP_GEOMETRY[size];

  const chip: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal,
    paddingVertical,
    borderRadius: radius.pill,
    backgroundColor: color.bg["3"],
  };

  const body = (
    <>
      {icon}
      <Text variant={size} weight='semibold' tone='secondary' numberOfLines={1}>
        {label}
      </Text>
      {href ? (
        <Icon
          name='openExternal'
          size={size === "micro" ? 9 : 11}
          tone='tertiary'
        />
      ) : null}
    </>
  );

  if (!href) {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel ?? label}
        style={chip}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole='link'
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={() => void Linking.openURL(href)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        chip,
        { opacity: hovered ? 0.7 : 1 },
        isWeb ? ({ cursor: "pointer" } as ViewStyle) : null,
      ]}
    >
      {body}
    </Pressable>
  );
}
