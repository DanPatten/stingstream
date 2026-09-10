import { Ionicons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import {
  type QueryObserverResult,
  type RefetchOptions,
  useQuery,
} from "@tanstack/react-query";
import { t } from "i18next";
import { orderBy } from "lodash";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { TouchableOpacity, View } from "react-native";
import { HorizontalScroll } from "@/components/common/HorizontalScroll";
import { Image } from "@/components/common/ServerImage";
import { Text } from "@/components/common/Text";
import { Tags } from "@/components/GenreTags";
import { dateOpts } from "@/components/jellyseerr/DetailFacts";
import { textShadowStyle } from "@/components/jellyseerr/discover/GenericSlideCard";
import JellyseerrStatusIcon from "@/components/jellyseerr/JellyseerrStatusIcon";
import { RoundButton } from "@/components/RoundButton";
import { confirmAction } from "@/components/stingstream/shared/confirm";
import { rgba } from "@/constants/theme";
import { useJellyseerr } from "@/hooks/useJellyseerr";
import { useTheme } from "@/hooks/useTheme";
import {
  MediaStatus,
  MediaType,
} from "@/utils/jellyseerr/server/constants/media";
import type MediaRequest from "@/utils/jellyseerr/server/entity/MediaRequest";
import type Season from "@/utils/jellyseerr/server/entity/Season";
import type { MediaRequestBody } from "@/utils/jellyseerr/server/interfaces/api/requestInterfaces";
import type { MovieDetails } from "@/utils/jellyseerr/server/models/Movie";
import type { TvDetails } from "@/utils/jellyseerr/server/models/Tv";
import { Loader } from "../Loader";

const JellyseerrSeasonEpisodes: React.FC<{
  details: TvDetails;
  seasonNumber: number;
}> = ({ details, seasonNumber }) => {
  const { jellyseerrApi } = useJellyseerr();

  const { data: seasonWithEpisodes, isLoading } = useQuery({
    queryKey: ["jellyseerr", details.id, "season", seasonNumber],
    queryFn: async () => jellyseerrApi?.tvSeason(details.id, seasonNumber),
    enabled: details.seasons.filter((s) => s.seasonNumber !== 0).length > 0,
  });

  return (
    <HorizontalScroll
      horizontal
      loading={isLoading}
      showsHorizontalScrollIndicator={false}
      data={seasonWithEpisodes?.episodes}
      keyExtractor={(item) => item.id.toString()}
      renderItem={(item, index) => (
        <RenderItem key={index} item={item} index={index} />
      )}
    />
  );
};

const RenderItem = ({ item }: any) => {
  const { color } = useTheme();
  const {
    jellyseerrApi,
    jellyseerrRegion: region,
    jellyseerrLocale: locale,
  } = useJellyseerr();
  const [imageError, setImageError] = useState(false);

  const upcomingAirDate = useMemo(() => {
    const airDate = item.airDate;
    if (airDate) {
      const airDateObj = new Date(airDate);
      if (new Date() < airDateObj) {
        return airDateObj.toLocaleDateString(`${locale}-${region}`, dateOpts);
      }
    }
  }, [item, locale, region]);

  return (
    <View className='flex flex-col w-44 mt-2'>
      <View
        style={{ borderColor: color.border.subtle }}
        className='relative aspect-video rounded-lg overflow-hidden border'
      >
        {!imageError ? (
          <>
            <Image
              key={item.id}
              id={item.id}
              source={{
                uri: jellyseerrApi?.imageProxy(item.stillPath),
              }}
              cachePolicy={"memory-disk"}
              contentFit='cover'
              className='w-full h-full'
              onError={(_e) => {
                setImageError(true);
              }}
            />
            {upcomingAirDate && (
              <View className='absolute justify-center bottom-0 right-0.5 items-center'>
                <View
                  style={{ backgroundColor: rgba(color.accent[500], 0.3) }}
                  className='rounded-full p-1'
                >
                  <Text
                    className='text-center text-xs'
                    style={textShadowStyle.shadow}
                  >
                    {upcomingAirDate}
                  </Text>
                </View>
              </View>
            )}
          </>
        ) : (
          <View
            style={{
              borderColor: color.border.subtle,
              backgroundColor: color.bg["1"],
            }}
            className='flex flex-col w-full h-full items-center justify-center border'
          >
            <Ionicons
              name='image-outline'
              size={24}
              color='white'
              style={{ opacity: 0.4 }}
            />
          </View>
        )}
      </View>
      <View className='shrink mt-1'>
        <Text numberOfLines={2} className=''>
          {item.name}
        </Text>
        <Text tone='tertiary' numberOfLines={1} className='text-xs'>
          {`S${item.seasonNumber}:E${item.episodeNumber}`}
        </Text>
      </View>
      <Text tone='tertiary' numberOfLines={3} className='text-xs shrink'>
        {item.overview}
      </Text>
    </View>
  );
};

const JellyseerrSeasons: React.FC<{
  isLoading: boolean;
  details?: TvDetails;
  hasAdvancedRequest?: boolean;
  onAdvancedRequest?: (data: MediaRequestBody) => void;
  refetch: (
    options?: RefetchOptions | undefined,
  ) => Promise<
    QueryObserverResult<TvDetails | MovieDetails | undefined, Error>
  >;
}> = ({
  isLoading,
  details,
  refetch,
  hasAdvancedRequest,
  onAdvancedRequest,
}) => {
  const { color } = useTheme();
  const { jellyseerrApi, requestMedia } = useJellyseerr();
  const [seasonStates, setSeasonStates] = useState<{ [key: number]: boolean }>(
    {},
  );
  const seasons = useMemo(() => {
    if (!details) return [];
    const mediaInfoSeasons = details.mediaInfo?.seasons?.filter(
      (s: Season) => s.seasonNumber !== 0,
    );
    const requestedSeasons =
      details.mediaInfo?.requests?.flatMap((r: MediaRequest) => r.seasons) ??
      [];
    return (
      details.seasons?.map((season) => ({
        ...season,
        status:
          mediaInfoSeasons?.find(
            (mediaSeason: Season) =>
              mediaSeason.seasonNumber === season.seasonNumber,
          )?.status ??
          requestedSeasons?.find(
            (s: Season) => s.seasonNumber === season.seasonNumber,
          )?.status ??
          MediaStatus.UNKNOWN,
      })) ?? []
    );
  }, [details]);
  const allSeasonsAvailable = useMemo(
    () => seasons.every((season) => season.status === MediaStatus.AVAILABLE),
    [seasons],
  );

  const requestAll = useCallback(() => {
    if (details && jellyseerrApi) {
      const body: MediaRequestBody = {
        mediaId: details.id,
        mediaType: MediaType.TV,
        tvdbId: details.externalIds?.tvdbId,
        seasons: seasons
          .filter(
            (s) => s.status === MediaStatus.UNKNOWN && s.seasonNumber !== 0,
          )
          .map((s) => s.seasonNumber),
      };
      if (hasAdvancedRequest) {
        return onAdvancedRequest?.(body);
      }
      requestMedia(details.name, body, refetch);
    }
  }, [
    jellyseerrApi,
    seasons,
    details,
    hasAdvancedRequest,
    onAdvancedRequest,
    requestMedia,
    refetch,
  ]);

  const promptRequestAll = useCallback(async () => {
    const ok = await confirmAction(
      t("jellyseerr.confirm"),
      t("jellyseerr.are_you_sure_you_want_to_request_all_seasons"),
      t("jellyseerr.yes"),
    );
    if (ok) requestAll();
  }, [requestAll]);

  const requestSeason = useCallback(
    async (canRequest: boolean, seasonNumber: number) => {
      if (canRequest && details) {
        const body: MediaRequestBody = {
          mediaId: details.id,
          mediaType: MediaType.TV,
          tvdbId: details.externalIds?.tvdbId,
          seasons: [seasonNumber],
        };
        if (hasAdvancedRequest) {
          return onAdvancedRequest?.(body);
        }
        requestMedia(`${details.name}, Season ${seasonNumber}`, body, refetch);
      }
    },
    [requestMedia, hasAdvancedRequest, onAdvancedRequest, refetch, details],
  );

  if (!details) return null;

  if (isLoading)
    return (
      <View>
        <View className='flex flex-row justify-between items-end px-4'>
          <Text className='text-lg font-bold mb-2'>
            {t("item_card.seasons")}
          </Text>
          {!allSeasonsAvailable && (
            <RoundButton className='mb-2 pa-2' onPress={promptRequestAll}>
              <Ionicons name='bag-add' color='white' size={26} />
            </RoundButton>
          )}
        </View>
        <Loader />
      </View>
    );

  return (
    <FlashList
      data={orderBy(
        seasons.filter((s) => s.seasonNumber !== 0),
        "seasonNumber",
        "desc",
      )}
      ListHeaderComponent={() => (
        <View className='flex flex-row justify-between items-end px-4'>
          <Text className='text-lg font-bold mb-2'>
            {t("item_card.seasons")}
          </Text>
          {!allSeasonsAvailable && (
            <RoundButton className='mb-2 pa-2' onPress={promptRequestAll}>
              <Ionicons name='bag-add' color='white' size={26} />
            </RoundButton>
          )}
        </View>
      )}
      ItemSeparatorComponent={() => <View className='h-2' />}
      renderItem={({ item: season }) => (
        <>
          <TouchableOpacity
            onPress={() =>
              setSeasonStates((prevState) => ({
                ...prevState,
                [season.seasonNumber]: !prevState?.[season.seasonNumber],
              }))
            }
            className='px-4'
          >
            <View
              style={{ backgroundColor: rgba(color.overlay, 0.1) }}
              className='flex flex-row justify-between items-center rounded-xl z-20 h-12 w-full px-4'
              key={season.id}
            >
              <Tags
                textClass=''
                tags={[
                  t("jellyseerr.season_number", {
                    season_number: season.seasonNumber,
                  }),
                  t("jellyseerr.number_episodes", {
                    episode_number: season.episodeCount,
                  }),
                ]}
              />
              {[0].map(() => {
                const canRequest = season.status === MediaStatus.UNKNOWN;
                return (
                  <JellyseerrStatusIcon
                    key={0}
                    onPress={() =>
                      requestSeason(canRequest, season.seasonNumber)
                    }
                    style={
                      canRequest
                        ? { backgroundColor: rgba(color.bg["3"], 0.4) }
                        : undefined
                    }
                    mediaStatus={season.status}
                    showRequestIcon={canRequest}
                  />
                );
              })}
            </View>
          </TouchableOpacity>
          {seasonStates?.[season.seasonNumber] && (
            <JellyseerrSeasonEpisodes
              key={season.seasonNumber}
              details={details}
              seasonNumber={season.seasonNumber}
            />
          )}
        </>
      )}
    />
  );
};

export default JellyseerrSeasons;
