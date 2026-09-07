import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { SectionHeader } from "@/components/common/SectionHeader";
import { Image } from "@/components/common/ServerImage";
import { Skeleton } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { getItemNavigation } from "@/components/common/TouchableItemRouter";
import { elevation, tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePressableStates } from "@/hooks/usePressableStates";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getPrimaryImageUrl } from "@/utils/jellyfin/image/getPrimaryImageUrl";

const AVATAR_SIZE = 76;
const isWeb = Platform.OS === "web";

interface Props {
  title: string;
  people?: BaseItemDto[];
  loading?: boolean;
  /** Route segment `getItemNavigation` prefixes onto a person's path. */
  from: string;
}

/**
 * People, as circular avatars — the one search result row that doesn't go
 * through `CardRow`. `Card`/`CardData` draw every other kind of result as a
 * rectangle (a poster, a still), and a headshot in the same rectangle reads as
 * a poster with the wrong picture on it; a person is the one thing in a
 * Jellyfin library people are used to seeing round.
 */
export const SearchPeopleRow: React.FC<Props> = ({
  title,
  people,
  loading = false,
  from,
}) => {
  const { gutter } = useBreakpoint();
  const isEmpty = !people || people.length === 0;

  if (!loading && isEmpty) return null;

  return (
    <View>
      <SectionHeader title={title} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: gutter,
          paddingVertical: 6,
          flexDirection: "row",
          gap: 16,
        }}
      >
        {loading
          ? Array.from({ length: 6 }, (_, index) => (
              <PersonAvatarSkeleton key={index} />
            ))
          : (people ?? []).flatMap((person) =>
              person.Id ? (
                <PersonAvatar key={person.Id} person={person} from={from} />
              ) : (
                []
              ),
            )}
      </ScrollView>
    </View>
  );
};

const PersonAvatar: React.FC<{ person: BaseItemDto; from: string }> = ({
  person,
  from,
}) => {
  const api = useAtomValue(apiAtom);
  const router = useRouter();
  const states = usePressableStates();
  const lifted = isWeb && states.hovered;

  const imageUrl = useMemo(
    () =>
      getPrimaryImageUrl({
        api,
        item: person,
        width: AVATAR_SIZE * 2,
      }),
    [api, person],
  );

  const onPress = useCallback(() => {
    router.push(getItemNavigation(person, from) as any);
  }, [router, person, from]);

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={person.Name ?? undefined}
      onPress={onPress}
      {...states.handlers}
      style={[
        {
          width: AVATAR_SIZE,
          alignItems: "center",
          transform: [{ scale: lifted ? tokens.motion.hoverScale : 1 }],
        },
        states.webStyle,
        isWeb && lifted ? elevation(1) : null,
      ]}
    >
      <View
        style={{
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
          borderRadius: AVATAR_SIZE / 2,
          overflow: "hidden",
          backgroundColor: tokens.color.bg["2"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            style={{ width: "100%", height: "100%" }}
            contentFit='cover'
            accessibilityLabel={person.Name ?? undefined}
          />
        ) : (
          <Icon name='user' size={34} tone='tertiary' />
        )}
      </View>
      <Text
        variant='caption'
        numberOfLines={2}
        align='center'
        style={{ marginTop: 6 }}
      >
        {person.Name}
      </Text>
    </Pressable>
  );
};

const PersonAvatarSkeleton: React.FC = () => (
  <View style={{ width: AVATAR_SIZE, alignItems: "center" }}>
    <Skeleton
      width={AVATAR_SIZE}
      height={AVATAR_SIZE}
      radius={AVATAR_SIZE / 2}
    />
    <Skeleton
      width={AVATAR_SIZE * 0.7}
      height={10}
      radius={4}
      style={{ marginTop: 8 }}
    />
  </View>
);
