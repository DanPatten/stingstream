import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { RequestFilterBar } from "@/components/filters/RequestFilterBar";
import {
  REQUEST_SEARCH_DEBOUNCE_MS,
  REQUEST_SEARCH_MIN_LENGTH,
} from "@/constants/Requests";
import {
  applyRequestFilters,
  DEFAULT_REQUEST_FILTERS,
  dedupeSearchResults,
  type RequestFilterState,
  type RequestKind,
  type RequestSearchResult,
  requestFiltersActive,
  useCanApproveRequests,
  useRequestDiscover,
  useRequestPolicy,
  useRequestSearch,
  useRequests,
} from "@/lib/stingstream/requests";
import { AddByIdDialog } from "../arr/AddByIdDialog";
import { RequestCardSkeletonList } from "./RequestCard";
import { RequestDiscoverGrid } from "./RequestDiscoverGrid";
import { RequestResultRow } from "./RequestResultRow";
import { RequestSheet } from "./RequestSheet";
import { RequestsErrorState } from "./RequestsErrorState";

/**
 * Find something to ask for — the Requests tab's own screen, on phone and web.
 *
 * This is where requesting lives. It was removed from here once, in favour of the Search tab
 * answering one box with both a library section and a catalogue section, and that turned out to be
 * two mistakes at once: the Request button was revealed only on hover, and the whole catalogue
 * section drew *nothing at all* when the node's lookup came back empty — so a member on the
 * Requests screen was shown a button that took them to a different tab where, on a node whose
 * managers were not configured, there was still nothing to press. See `docs/REQUESTS.md` §9.
 *
 * **The box belongs to this screen, at every width.** For a while wide web had no input here at
 * all: the shell's top-bar box drove the `q` route param and this section read it back, to avoid
 * two places to type one title. It avoided that and bought something worse — a control sitting
 * above the tab bar, so it read as furniture for all six sections while driving exactly one; five
 * tabs it did nothing on; a box that quietly meant something different on this page than on every
 * other; and an empty state reduced to giving directions to a control ("type into the box at the
 * top of the screen"), which is a screen admitting its input is in the wrong place. There is still
 * only one place to type, solved the other way round: the top bar no longer touches this screen, so
 * it means one thing everywhere — Enter opens the Search tab (`components/shell/SearchField.tsx`).
 *
 * **Nothing typed is a screen, not a blank.** It used to be an empty state and six public-domain
 * titles offered as example searches, because no endpoint could answer "what is popular" and a
 * fabricated row would have been worse than none. The node has a catalogue now, so the screen opens
 * on the most popular sixty titles, or the best ever made, and somebody who does not already know
 * what they want has something to look at instead of a prompt telling them to think of something.
 *
 * **One filter bar over both halves.** The chips are the library's own — the same component, the
 * same sheet, the same Clear — because narrowing a catalogue and narrowing a library are the same
 * gesture and there is no reason to make somebody learn it twice. What differs is where the
 * narrowing happens: the feed hands genre, year and order to the node, so its sixty really are the
 * top sixty of that slice; a search narrows what came back, because re-asking the catalogue with
 * the typed term would be a different search rather than a narrower one. `applyRequestFilters`
 * holds both rules.
 *
 * Every result says what the *group* already thinks about it, which is the whole difference between
 * this and a Seerr: in a group that pools libraries the interesting answer is usually "somebody
 * already has this", and discovering that after pressing Request is too late to be useful.
 */
export function FindSection({
  term = "",
  kind: entryKind,
}: {
  term?: string;
  kind?: RequestKind;
}) {
  const { t } = useTranslation();

  // `term` is the `q` route param, which is an *entry* term rather than a mirror of this box:
  // Search's `Request "…"` button hands a title over with it (and `tab=find`), and nothing on this
  // screen writes it back. Seeding both halves means that handoff shows results straight away
  // instead of sitting empty through a debounce it never needed.
  const [typed, setTyped] = useState(term);
  const [debounced, setDebounced] = useState(term);
  // `kind` is the other half of that handoff, and the same shape: an *entry* filter rather than a
  // mirror of the bar. A Movies library's empty state hands `kind=movie` over, so somebody who came
  // here looking for a movie is shown movies rather than everything the catalogue has. Nothing on
  // this screen writes it back, so pressing All is a real choice and stays.
  const [filters, setFilters] = useState<RequestFilterState>(
    entryKind
      ? { ...DEFAULT_REQUEST_FILTERS, kind: entryKind }
      : DEFAULT_REQUEST_FILTERS,
  );
  const [picking, setPicking] = useState<RequestSearchResult | null>(null);
  const [addingById, setAddingById] = useState(false);

  /**
   * Open the sheet on a title. Every press on this screen, of every kind, does this.
   *
   * A film used to be created straight from the row instead, on the reasoning that there was
   * nothing to decide about one and the sheet only repeated the row back with a second Request
   * button on it. That stopped being true as the sheet grew: it now says what the library already
   * has, offers to play it, asks why a held title is wanted again, and carries what this server
   * does about a title it already tracks. A film has all of that to show and was the one kind that
   * never got to show it, so the same title read as one thing under Films and another under TV.
   *
   * Dan: *"update movies to work like tv shows when requesting (always show the dialog first)"*.
   *
   * Which leaves the sheet as the only place a request is ever made from, and this screen with no
   * opinion about kind: rows, posters, held titles and titles already asked for all arrive at the
   * same place, and the sheet reads `searchAction` to decide what it offers.
   */
  const act = (result: RequestSearchResult) => {
    setPicking(result);
  };

  // Guarded on being different so a re-render cannot push a stale `q` back over what is being
  // typed now. Same shape, and the same reason, as the guard in `SearchField`.
  useEffect(() => {
    if (!term) return;
    setTyped((current) => (term === current ? current : term));
  }, [term]);

  // The same guard, for the same reason. This section stays mounted while its tab is open, so a
  // second arrival naming a different kind has to move the bar, while a re-render carrying the kind
  // already set must not undo a chip pressed since.
  useEffect(() => {
    if (!entryKind) return;
    setFilters((current) =>
      current.kind === entryKind ? current : { ...current, kind: entryKind },
    );
  }, [entryKind]);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(typed),
      REQUEST_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [typed]);

  const searching = debounced.trim().length >= REQUEST_SEARCH_MIN_LENGTH;

  // Narrowing a search is a real re-query on `?kind=`, which is one lookup the node does not have
  // to make. React Query caches per `(term, kind)`, so coming back to All is instant.
  const kind = filters.kind === "all" ? undefined : filters.kind;
  const search = useRequestSearch(debounced, kind);
  const discover = useRequestDiscover(filters);
  const policy = useRequestPolicy();
  const canAdmin = useCanApproveRequests();
  // Off the key the Requests list already polls, so a title asked for a moment ago shows as
  // requested here without waiting for the node's own annotation to catch up.
  const mine = useRequests({ mine: true });

  const rows = useMemo(
    () =>
      applyRequestFilters(
        dedupeSearchResults(search.data ?? [], mine.data ?? []),
        filters,
      ),
    [search.data, mine.data, filters],
  );

  // The node has already applied genre, year and order to the feed. Running it through the same
  // rule anyway is what makes Availability work here, since that is the one thing the node cannot
  // answer for a title it has not been asked about.
  const feed = useMemo(
    () =>
      applyRequestFilters(
        // Through the same annotation the search rows get, so a title asked for a moment ago shows
        // as requested here too. Without it the catalogue was the one list where pressing Request
        // left the tile looking untouched, and the Requested availability filter could not see it.
        dedupeSearchResults(discover.data?.results ?? [], mine.data ?? []),
        filters,
      ),
    [discover.data, mine.data, filters],
  );

  const results = () => {
    if (search.isLoading) return <RequestCardSkeletonList />;
    if (search.error) {
      return (
        <RequestsErrorState error={search.error} onRetry={search.refetch} />
      );
    }
    if (rows.length === 0) {
      return (
        <EmptyState
          icon='search'
          title={t("requests.discover_empty_title")}
          detail={t("requests.discover_empty_detail", {
            term: debounced.trim(),
          })}
          // Offered only to somebody who can act on it, and it is the escape hatch rather than a
          // second search: a lookup that cannot name the title still accepts its provider id.
          // Two different things land here — a real no-match, and a node whose managers are off,
          // which answers an empty list rather than the 503 `RequestsErrorState` handles — so the
          // copy covers both while the button answers the first.
          action={
            canAdmin
              ? {
                  label: t("requests.add_by_id_title"),
                  icon: "settings",
                  onPress: () => setAddingById(true),
                }
              : undefined
          }
        />
      );
    }
    return (
      <View testID='requests-results'>
        {rows.map((result) => (
          <RequestResultRow
            key={result.itemKey || `${result.kind}:${result.title}`}
            result={result}
            onPress={() => act(result)}
          />
        ))}
      </View>
    );
  };

  const catalogue = () => {
    if (discover.error) {
      return (
        <RequestsErrorState error={discover.error} onRetry={discover.refetch} />
      );
    }
    // Nothing came back and nothing is narrowing it: the catalogue itself is quiet. Different from
    // a filter that matched nothing, and the two must not share a sentence — one is about the
    // server and the other is about what was just pressed.
    if (!discover.isLoading && feed.length === 0) {
      const narrowed = requestFiltersActive(filters);
      return (
        <EmptyState
          icon='search'
          title={
            narrowed
              ? t("requests.discover_filtered_title")
              : t("requests.discover_quiet_title")
          }
          detail={
            narrowed
              ? t("requests.discover_filtered_detail")
              : t("requests.discover_quiet_detail")
          }
          action={
            narrowed
              ? {
                  label: t("library.filters.clear"),
                  icon: "close",
                  onPress: () => setFilters(DEFAULT_REQUEST_FILTERS),
                }
              : undefined
          }
        />
      );
    }
    return (
      <RequestDiscoverGrid
        results={feed}
        loading={discover.isLoading}
        onPress={act}
      />
    );
  };

  return (
    <View>
      {/*
        Landing on Find puts the caret in the box. This section only exists while its tab is the
        open one — `?tab=find`, a press on the tab, or Search handing a title over — so mounting
        *is* landing, and every one of those arrivals is somebody who came here to type.

        Not when a term arrived with them: the box has already been filled and the results are
        below it, and on a phone the keyboard would open over the answer they came to read. Same
        shape as `ConnectScreen`'s `autoFocus={initialUrl.length === 0}`.
      */}
      <Input
        testID='requests-search'
        value={typed}
        onChangeText={setTyped}
        placeholder={t("requests.search_placeholder")}
        icon='search'
        autoCorrect={false}
        autoFocus={term.trim().length === 0}
        returnKeyType='search'
      />

      {/*
        Only when *every* request waits for somebody. The other half of this — "…unless you are
        trusted" — said nothing a member could act on: they cannot see whether they are trusted, so
        it warned everybody about a queue most of them never enter, above a search they had not run
        yet. Under a `trusted` policy the answer arrives where it is certain instead: the toast on
        Request says "waiting for approval" when the node held it, and the row turns to "Awaiting
        approval" as the request lands.
      */}
      {policy.data?.autoApprove === "admins_only" ? (
        <Text variant='caption' tone='secondary' style={{ marginTop: 10 }}>
          {t("requests.policy_hint_admins_only")}
        </Text>
      ) : null}

      {/*
        Always here, over both halves. The chips used to wait for a search, on the reasoning that
        before there is a result set they are controls that do nothing — true then, and the opposite
        now: with a feed under them there is always something to narrow, and a bar that appeared
        only once you typed would be a bar most readers never saw.
      */}
      <RequestFilterBar
        state={filters}
        set={setFilters}
        genres={discover.data?.genres ?? []}
      />

      {searching ? results() : catalogue()}

      {/*
        The open request behind the row, when there is one, so the sheet can edit it rather than
        ask again. `mine` is already loaded for `dedupeSearchResults`, so this costs no request.
      */}
      <RequestSheet
        result={picking}
        existing={
          (picking?.requestId &&
            (mine.data ?? []).find((r) => r.id === picking.requestId)) ||
          null
        }
        onClose={() => setPicking(null)}
      />

      {/*
        The escape hatch behind the no-match empty state, mounted here so the dialog is not torn
        down by the search that is still running underneath it.
      */}
      {canAdmin ? (
        <AddByIdDialog
          visible={addingById}
          onClose={() => setAddingById(false)}
        />
      ) : null}
    </View>
  );
}
