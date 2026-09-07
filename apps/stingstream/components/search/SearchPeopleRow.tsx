import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { buildItemCards, type CardData } from "@/components/cards/CardData";
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
 *
 * Cards come from `buildItemCards` — the same builder every other row uses —
 * rather than a bare `getPrimaryImageUrl` call: that function always returns
 * *some* URL for a real `BaseItemDto` (untagged or not — see its own
 * comment), so calling it directly for a person with no `ImageTags.Primary`
 * requested an image the server had no way to answer and drew a real 404.
 * `buildItemCards`'s own `hasArtwork` gate is what leaves `imageUrl` unset
 * for exactly that case, which is what puts the initials glyph on screen
 * instead (confirmed live: a person search dropped the request entirely once
 * this went through the builder).
 */
export const SearchPeopleRow: React.FC<Props> = ({
  title,
  people,
  loading = false,
  from,
}) => {
  const { gutter } = useBreakpoint();
  const api = useAtomValue(apiAtom);
  const isEmpty = !people || people.length === 0;

  const cards = useMemo(
    () =>
      // `cardWidth` is the avatar's *rendered* width — `buildItemCards`
      // itself caps the actual image request at 2x for pixel density.
      buildItemCards(people ?? [], {
        api,
        kind: "portrait",
        cardWidth: AVATAR_SIZE,
      }),
    [people, api],
  );

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
          : cards.map((card) => (
              <PersonAvatar key={card.id} card={card} from={from} />
            ))}
      </ScrollView>
    </View>
  );
};

const PersonAvatar: React.FC<{ card: CardData; from: string }> = ({
  card,
  from,
}) => {
  const router = useRouter();
  const states = usePressableStates();
  const lifted = isWeb && states.hovered;
  const label = card.imageAlt ?? card.title;

  const onPress = useCallback(() => {
    // `getItemNavigation` only reads `item.Id`/`Type`, both of which the
    // card already carries — a person doesn't need the rest of the DTO to
    // route to its own page.
    router.push(
      getItemNavigation(
        { Id: card.id, Type: "Person" } as BaseItemDto,
        from,
      ) as any,
    );
  }, [router, card.id, from]);

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
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
        {card.imageUrl ? (
          <Image
            source={{ uri: card.imageUrl }}
            style={{ width: "100%", height: "100%" }}
            contentFit='cover'
            accessibilityLabel={label}
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
        {card.title}
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
