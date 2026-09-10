import { Ionicons } from "@expo/vector-icons";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useMemo } from "react";
import { View, type ViewProps } from "react-native";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import { useJellyseerr } from "@/hooks/useJellyseerr";
import { useTheme } from "@/hooks/useTheme";
import { MediaType } from "@/utils/jellyseerr/server/constants/media";
import type { MovieDetails } from "@/utils/jellyseerr/server/models/Movie";
import type {
  MovieResult,
  TvResult,
} from "@/utils/jellyseerr/server/models/Search";
import type { TvDetails } from "@/utils/jellyseerr/server/models/Tv";
import { AwardsBadge } from "./AwardsBadge";
import { Badge } from "./Badge";

interface Props extends ViewProps {
  item?: BaseItemDto | null;
  /**
   * Include the age rating. Off by default on the details page, where the
   * metadata line already carries it and a second copy is just noise.
   */
  showOfficialRating?: boolean;
}

/**
 * A small row of scores under the metadata line.
 *
 * Deliberately quiet: these are chips on `bg2` with a glyph, not the loud
 * outlined badges the fork drew. Ratings are a footnote to a title, and pass-02
 * had three of them shouting at the top-left corner of the page with no gutter
 * at all.
 */
export const Ratings: React.FC<Props> = ({
  item,
  showOfficialRating = false,
  className,
  ...props
}) => {
  if (!item) return null;

  const hasAny =
    (showOfficialRating && item.OfficialRating) ||
    item.CommunityRating ||
    item.CriticRating;
  if (!hasAny) return <AwardsBadge item={item} />;

  return (
    <View
      {...props}
      className={className}
      style={[
        {
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        },
        props.style,
      ]}
    >
      {showOfficialRating && item.OfficialRating ? (
        <Chip label={item.OfficialRating} />
      ) : null}

      {item.CommunityRating ? (
        <Chip
          label={item.CommunityRating.toFixed(1)}
          icon={<Ionicons name='star' size={13} color='#E0B34A' />}
          accessibilityLabel={`${item.CommunityRating.toFixed(1)} out of 10`}
        />
      ) : null}

      {item.CriticRating ? (
        <Chip
          label={`${item.CriticRating}%`}
          icon={
            <Image
              source={
                item.CriticRating < 60
                  ? require("@/assets/images/rt_rotten.svg")
                  : require("@/assets/images/rt_fresh.svg")
              }
              style={{ width: 13, height: 13 }}
            />
          }
        />
      ) : null}

      <AwardsBadge item={item} />
    </View>
  );
};

/**
 * A rating chip.
 *
 * Not `Pill`: a rating is a glyph plus a number, and `Pill`'s icon slot only
 * takes a name from the semantic registry — there is no Ionicon for "Rotten
 * Tomatoes" and there should not be one.
 */
const Chip: React.FC<{
  label: string;
  icon?: React.ReactNode;
  accessibilityLabel?: string;
}> = ({ label, icon, accessibilityLabel }) => {
  const { color } = useTheme();

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel ?? label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: radius.pill,
        backgroundColor: color.bg["3"],
      }}
    >
      {icon}
      <Text variant='caption' weight='semibold' tone='secondary'>
        {label}
      </Text>
    </View>
  );
};

export const JellyserrRatings: React.FC<{
  result: MovieResult | TvResult | TvDetails | MovieDetails;
}> = ({ result }) => {
  const { jellyseerrApi, getMediaType } = useJellyseerr();

  const mediaType = useMemo(() => getMediaType(result), [result]);

  const { data, isLoading } = useQuery({
    queryKey: ["jellyseerr", result.id, mediaType, "ratings"],
    queryFn: async () => {
      return mediaType === MediaType.MOVIE
        ? jellyseerrApi?.movieRatings(result.id)
        : jellyseerrApi?.tvRatings(result.id);
    },
    staleTime: (5).minutesToMilliseconds(),
    retry: false,
    enabled: !!jellyseerrApi,
  });

  return (
    (isLoading ||
      !!result.voteCount ||
      (data?.criticsRating && !!data?.criticsScore) ||
      (data?.audienceRating && !!data?.audienceScore)) && (
      <View className='flex flex-row flex-wrap space-x-1'>
        {data?.criticsRating && !!data?.criticsScore && (
          <Badge
            text={`${data.criticsScore}%`}
            variant='gray'
            iconLeft={
              <Image
                className='mr-1'
                source={
                  data?.criticsRating === "Rotten"
                    ? require("@/assets/images/rt_rotten.svg")
                    : require("@/assets/images/rt_fresh.svg")
                }
                style={{
                  width: 14,
                  height: 14,
                }}
              />
            }
          />
        )}
        {data?.audienceRating && !!data?.audienceScore && (
          <Badge
            text={`${data.audienceScore}%`}
            variant='gray'
            iconLeft={
              <Image
                className='mr-1'
                source={
                  data?.audienceRating === "Spilled"
                    ? require("@/assets/images/rt_aud_rotten.svg")
                    : require("@/assets/images/rt_aud_fresh.svg")
                }
                style={{
                  width: 14,
                  height: 14,
                }}
              />
            }
          />
        )}
        {!!result.voteCount && (
          <Badge
            text={`${Math.round(result.voteAverage * 10)}%`}
            variant='gray'
            iconLeft={
              <Image
                className='mr-1'
                source={require("@/assets/images/tmdb_logo.svg")}
                style={{
                  width: 14,
                  height: 14,
                }}
              />
            }
          />
        )}
      </View>
    )
  );
};
