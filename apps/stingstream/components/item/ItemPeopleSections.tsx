import type {
  BaseItemDto,
  BaseItemPerson,
} from "@jellyfin/sdk/lib/generated-client/models";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { InteractionManager, View, type ViewProps } from "react-native";
import { MoreMoviesWithActor } from "@/components/MoreMoviesWithActor";
import { useItemPeopleQuery } from "@/hooks/useItemPeopleQuery";
import { useOfflineMode } from "@/providers/OfflineModeProvider";
import { CastRow } from "./CastRow";

interface Props extends ViewProps {
  item: BaseItemDto;
  /** Actor filmography rows under the cast. Off where the page is already long. */
  showFilmographies?: boolean;
}

/**
 * The cast, and a row of other work by the first few of them.
 *
 * The people query is deferred until after the first interactions settle: it is
 * a second round trip for a section nobody sees until they scroll, and running
 * it with the item query put it in front of the artwork on a cold cache.
 *
 * `enabled` gates the *query*, not the row. It used to gate both — the whole
 * section returned `null` until the deferred flag flipped — which is why the row
 * appeared out of nowhere half a second after the page settled. Now the row
 * mounts immediately and shows its skeletons, which is what a skeleton is for.
 */
export const ItemPeopleSections: React.FC<Props> = ({
  item,
  showFilmographies = true,
  ...props
}) => {
  const isOffline = useOfflineMode();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (isOffline) return;
    const task = InteractionManager.runAfterInteractions(() =>
      setEnabled(true),
    );
    return () => task.cancel();
  }, [isOffline]);

  const { data, isLoading } = useItemPeopleQuery(
    item.Id,
    enabled && !isOffline,
  );

  // The item's own People (from the details query) stand in until the dedicated
  // one lands, so a page that already has the cast never draws a skeleton.
  const people = useMemo(
    () => (Array.isArray(data) && data.length > 0 ? data : (item.People ?? [])),
    [data, item.People],
  );

  const topPeople = useMemo(() => {
    const seen = new Set<string>();
    const unique: BaseItemPerson[] = [];
    for (const person of people) {
      if (!person.Id || seen.has(person.Id)) continue;
      seen.add(person.Id);
      unique.push(person);
      if (unique.length >= 3) break;
    }
    return unique;
  }, [people]);

  const renderActorSection = useCallback(
    (person: BaseItemPerson, idx: number, total: number) => {
      if (!person.Id) return null;

      return (
        <MoreMoviesWithActor
          key={person.Id}
          currentItem={item}
          actorId={person.Id}
          actorName={person.Name}
          className={idx === total - 1 ? undefined : "mb-2"}
        />
      );
    },
    [item],
  );

  if (isOffline) return null;

  return (
    <View {...props}>
      <CastRow
        people={people}
        loading={people.length === 0 && (isLoading || !enabled)}
      />
      {showFilmographies && topPeople.length > 0 ? (
        <View style={{ marginTop: 24 }}>
          {topPeople.map((person, idx) =>
            renderActorSection(person, idx, topPeople.length),
          )}
        </View>
      ) : null}
    </View>
  );
};
