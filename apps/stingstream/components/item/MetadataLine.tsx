import type {
  BaseItemDto,
  MediaStream,
} from "@jellyfin/sdk/lib/generated-client/models";
import type React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { buildBadges, buildMetadataLine } from "./metadata";

interface Props {
  item: BaseItemDto;
  /** The streams the badges describe — the chosen source, usually. */
  streams?: MediaStream[] | null;
  style?: StyleProp<ViewStyle>;
}

/**
 * `1922 · 1h 34m · NR · Horror, Fantasy` and the quality badges, on one line.
 *
 * The dots are their own `Text` in `tertiary` rather than characters inside the
 * segments: punctuation that recedes reads as a separator, punctuation in the
 * same color as the words reads as part of them. `flexWrap` is deliberate —
 * "one line" is the goal at every width the design targets, but a 320 dp phone
 * with a five-genre film has to put the rest somewhere, and wrapping is better
 * than truncating the age rating away.
 */
export const MetadataLine: React.FC<Props> = ({ item, streams, style }) => {
  const { t } = useTranslation();

  const episodeLabel = useMemo(() => {
    if (item.Type !== "Episode") return null;
    const season = item.ParentIndexNumber;
    const episode = item.IndexNumber;
    if (season == null && episode == null) return null;
    if (season == null) return t("item.episode_number", { episode });
    if (episode == null) return t("item.season_number", { season });
    return t("item.season_episode", { season, episode });
  }, [item, t]);

  const segments = useMemo(
    () => buildMetadataLine(item, { episodeLabel }),
    [item, episodeLabel],
  );
  const badges = useMemo(() => buildBadges(streams), [streams]);

  if (segments.length === 0 && badges.length === 0) return null;

  return (
    <View
      style={[
        {
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          // A 4-pt row gap keeps the two lines from touching when it does wrap.
          rowGap: 6,
        },
        style,
      ]}
    >
      {segments.map((segment, index) => (
        <View
          key={segment}
          style={{ flexDirection: "row", alignItems: "center" }}
        >
          {index > 0 ? (
            <Text
              variant='body'
              tone='tertiary'
              style={{ marginHorizontal: 8 }}
              accessibilityElementsHidden
              importantForAccessibility='no'
            >
              ·
            </Text>
          ) : null}
          <Text variant='body' tone='secondary'>
            {segment}
          </Text>
        </View>
      ))}

      {badges.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            marginLeft: segments.length > 0 ? 12 : 0,
          }}
        >
          {badges.map((badge) => (
            <Pill key={badge} label={badge} size='sm' tone='neutral' />
          ))}
        </View>
      ) : null}
    </View>
  );
};
