import type { BaseItemPerson } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { SectionHeader } from "@/components/common/SectionHeader";
import { Image } from "@/components/common/ServerImage";
import { Skeleton } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { elevation, radius, tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePressableStates } from "@/hooks/usePressableStates";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getPrimaryImageUrl } from "@/utils/jellyfin/image/getPrimaryImageUrl";
import { dedupePeople, initialsOf, roleCaption } from "./cast";

const AVATAR = 96;
const TILE_WIDTH = 112;
const SKELETON_COUNT = 6;

interface Props {
  people?: BaseItemPerson[] | null;
  loading?: boolean;
  title?: string;
}

/**
 * The cast, as faces.
 *
 * Circular, because a headshot is not a poster and a 2:3 crop of one is a
 * portrait of a forehead — and because it makes the row unmistakably *people*
 * next to the rectangular rows above and below it.
 *
 * The rule the pass-02 page broke: **a skeleton is a promise.** That page drew
 * eleven empty grey boxes at 1440 and left them there for good, because the row
 * rendered its placeholder whether or not anything was ever coming. Here the
 * skeletons exist only while the query is in flight; after that it is faces, or
 * it is nothing at all.
 */
export const CastRow: React.FC<Props> = ({
  people,
  loading = false,
  title,
}) => {
  const { t } = useTranslation();
  const { gutter } = useBreakpoint();
  const cast = useMemo(() => dedupePeople(people), [people]);

  if (!loading && cast.length === 0) return null;

  return (
    <View testID='details-cast'>
      <SectionHeader title={title ?? t("item.cast")} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: gutter,
          paddingVertical: 4,
          gap: 16,
        }}
      >
        {loading
          ? Array.from({ length: SKELETON_COUNT }, (_, index) => (
              <View key={index} style={{ width: TILE_WIDTH }}>
                <Skeleton
                  width={AVATAR}
                  height={AVATAR}
                  radius={radius.pill}
                  style={{ alignSelf: "center" }}
                />
                <Skeleton
                  height={12}
                  radius={4}
                  width='80%'
                  style={{ marginTop: 10, alignSelf: "center" }}
                />
                <Skeleton
                  height={10}
                  radius={4}
                  width='55%'
                  style={{ marginTop: 6, alignSelf: "center" }}
                />
              </View>
            ))
          : cast.map((person) => <CastTile key={person.Id} person={person} />)}
      </ScrollView>
    </View>
  );
};

const CastTile: React.FC<{ person: BaseItemPerson }> = ({ person }) => {
  const api = useAtomValue(apiAtom);
  const router = useRouter();
  const states = usePressableStates({});
  // A tag is the server saying it *has* a photo, which is not the same as the
  // photo loading. When it does not, the tile falls back to initials rather
  // than staying an empty grey circle — the pass-02 defect in miniature.
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = useMemo(
    () =>
      person.PrimaryImageTag ? getPrimaryImageUrl({ api, item: person }) : null,
    [api, person],
  );
  const showImage = Boolean(imageUrl) && !imageFailed;
  const role = useMemo(() => roleCaption(person.Role), [person.Role]);

  return (
    <Pressable
      testID='cast-tile'
      accessibilityRole='button'
      accessibilityLabel={
        role ? `${person.Name} — ${role}` : (person.Name ?? "")
      }
      onPress={() =>
        person.Id &&
        router.push({
          pathname: "/persons/[personId]",
          params: { personId: person.Id },
        })
      }
      {...states.handlers}
      style={[{ width: TILE_WIDTH, alignItems: "center" }, states.webStyle]}
    >
      <View
        style={[
          {
            width: AVATAR,
            height: AVATAR,
            borderRadius: radius.pill,
            overflow: "hidden",
            backgroundColor: tokens.color.bg["2"],
            borderWidth: 1,
            borderColor: states.hovered
              ? tokens.color.border.strong
              : tokens.color.border.subtle,
            alignItems: "center",
            justifyContent: "center",
          },
          states.hovered ? elevation(1) : null,
        ]}
      >
        {showImage ? (
          <Image
            source={imageUrl as string}
            style={{ width: "100%", height: "100%" }}
            contentFit='cover'
            cachePolicy='memory-disk'
            transition={200}
            onError={() => setImageFailed(true)}
          />
        ) : person.Name ? (
          // Initials, never an empty grey circle: a tile with two letters in it
          // says "we know who this is, we just have no photo".
          <Text variant='heading' tone='tertiary' weight='semibold'>
            {initialsOf(person.Name)}
          </Text>
        ) : (
          <Icon name='user' size={32} tone='tertiary' />
        )}
      </View>
      {/* `alignSelf: "stretch"` is what keeps a caption inside its tile. The
          column centres its children, which sizes a text box to its own content
          — so "Dr. Emmett Brown / Professor" measured wider than the 112 px tile
          and hung out of the row (F-57). Stretched, the box is the tile's width
          and the clamp has something to clamp to. */}
      <Text
        variant='caption'
        weight='medium'
        align='center'
        numberOfLines={2}
        style={{ marginTop: 10, alignSelf: "stretch" }}
      >
        {person.Name}
      </Text>
      {role ? (
        <Text
          variant='micro'
          tone='tertiary'
          align='center'
          numberOfLines={2}
          style={{ marginTop: 2, alignSelf: "stretch" }}
        >
          {role}
        </Text>
      ) : null}
    </Pressable>
  );
};
