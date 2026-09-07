import type { BaseItemPerson } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
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

const AVATAR = 96;
const TILE_WIDTH = 112;
const SKELETON_COUNT = 6;

/** Two letters from a name, for a cast member the server has no photo of. */
export const initialsOf = (name: string | null | undefined): string => {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
};

/** Same person credited twice (actor and writer) is one tile with both roles. */
export const dedupePeople = (
  people: BaseItemPerson[] | null | undefined,
): BaseItemPerson[] => {
  const byId = new Map<string, BaseItemPerson>();
  for (const person of people ?? []) {
    if (!person.Id) continue;
    const existing = byId.get(person.Id);
    if (!existing) {
      byId.set(person.Id, { ...person });
      continue;
    }
    if (person.Role && existing.Role && !existing.Role.includes(person.Role)) {
      existing.Role = `${existing.Role}, ${person.Role}`;
    } else if (person.Role && !existing.Role) {
      existing.Role = person.Role;
    }
  }
  return [...byId.values()];
};

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
  const imageUrl = useMemo(
    () =>
      person.PrimaryImageTag ? getPrimaryImageUrl({ api, item: person }) : null,
    [api, person],
  );

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={
        person.Role ? `${person.Name} — ${person.Role}` : (person.Name ?? "")
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
        {imageUrl ? (
          <Image
            source={imageUrl}
            style={{ width: "100%", height: "100%" }}
            contentFit='cover'
            cachePolicy='memory-disk'
            transition={200}
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
      <Text
        variant='caption'
        weight='medium'
        align='center'
        numberOfLines={2}
        style={{ marginTop: 10 }}
      >
        {person.Name}
      </Text>
      {person.Role ? (
        <Text
          variant='micro'
          tone='tertiary'
          align='center'
          numberOfLines={1}
          style={{ marginTop: 2 }}
        >
          {person.Role}
        </Text>
      ) : null}
    </Pressable>
  );
};
