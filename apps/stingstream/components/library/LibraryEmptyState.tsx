import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/common/EmptyState";
import useRouter from "@/hooks/useAppRouter";
import { useRequestsAvailable } from "@/lib/stingstream/requests";
import type { RequestKind } from "@/lib/stingstream/requestsApi";

/**
 * The two collection types the catalogue can answer for, and what Find calls them.
 *
 * Box sets, playlists, home videos, music videos and photos are absent on purpose: a request is
 * asking the node to fetch a title from an indexer, and none of those is a title anybody can fetch.
 * A library of that kind keeps the plain "No results" it has always had rather than being offered
 * an errand that cannot be run.
 */
const REQUESTABLE: Record<
  string,
  { kind: RequestKind; title: string; detail: string; action: string }
> = {
  movies: {
    kind: "movie",
    title: "library.empty_movies_title",
    detail: "library.empty_movies_detail",
    action: "library.empty_movies_action",
  },
  tvshows: {
    kind: "series",
    title: "library.empty_series_title",
    detail: "library.empty_series_detail",
    action: "library.empty_series_action",
  },
};

/**
 * "There is nothing in this library", said usefully.
 *
 * A grid with nothing in it used to say `No results` and stop, which is true of three different
 * situations and helpful in none of them. They are separated here because the reader's next move is
 * different in each:
 *
 * - **Filters emptied it.** The library is fine and the last chip pressed is the problem, so the
 *   action is Clear rather than anything to do with requesting. Offering Request here would send
 *   somebody off to ask for a film they very likely already have.
 * - **A Movies or TV shows library really is empty.** This is the one worth acting on, and Find is
 *   where the acting happens: the button carries `tab=find` and the `kind` of the library it was
 *   pressed in, so the catalogue that opens is already narrowed to what the reader was looking at.
 *   `RequestFilterBar`'s All chip is one press away if they want the rest.
 * - **Anything else is empty.** No catalogue answers for box sets or playlists, so there is nothing
 *   to offer and the state says only what it knows.
 *
 * Web and phone only. On a television the library grid keeps its one line of text: Requests drops
 * Find on TV entirely, because searching a catalogue needs a keyboard, so the button would lead to
 * a screen that cannot serve it.
 */
export const LibraryEmptyState: React.FC<{
  /** The library's `CollectionType`, as Jellyfin reports it. */
  collectionType?: string | null;
  /** Whether a filter, a tag or a non-default sort is what emptied the grid. */
  narrowed: boolean;
  onClear: () => void;
}> = ({ collectionType, narrowed, onClear }) => {
  const { t } = useTranslation();
  const router = useRouter();
  // The same probe the Requests screen gates itself on, off the same cached key, so this costs no
  // extra call. `data === false` specifically: a probe in flight or one that failed for some other
  // reason leaves the button offered, exactly as the Requests screen lets those through.
  const available = useRequestsAvailable();

  if (narrowed) {
    return (
      <EmptyState
        icon='search'
        title={t("library.filtered_title")}
        detail={t("library.filtered_detail")}
        action={{
          label: t("library.filters.clear"),
          icon: "close",
          onPress: onClear,
        }}
        style={{ paddingTop: "20%" }}
      />
    );
  }

  const requestable = collectionType ? REQUESTABLE[collectionType] : undefined;

  if (!requestable || available.data === false) {
    return (
      <EmptyState
        title={t("library.no_results")}
        style={{ paddingTop: "20%" }}
      />
    );
  }

  return (
    <EmptyState
      icon='library'
      title={t(requestable.title)}
      detail={t(requestable.detail)}
      action={{
        label: t(requestable.action),
        icon: "requests",
        onPress: () =>
          router.push({
            pathname: "/requests",
            params: { tab: "find", kind: requestable.kind },
          }),
      }}
      style={{ paddingTop: "20%" }}
    />
  );
};
