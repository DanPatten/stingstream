import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { toast } from "sonner-native";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/common/Input";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { FilterChip } from "@/components/filters/FilterChip";
import {
  REQUEST_EXAMPLE_SEARCHES,
  REQUEST_SEARCH_DEBOUNCE_MS,
  REQUEST_SEARCH_MIN_LENGTH,
} from "@/constants/Requests";
import useRouter from "@/hooks/useAppRouter";
import {
  dedupeSearchResults,
  type RequestSearchResult,
  useCanApproveRequests,
  useCreateRequest,
  useRequestPolicy,
  useRequestSearch,
  useRequests,
} from "@/lib/stingstream/requests";
import { RequestCardSkeletonList } from "./RequestCard";
import { RequestResultRow } from "./RequestResultRow";
import { RequestSheet } from "./RequestSheet";
import { RequestsErrorState } from "./RequestsErrorState";
import { requestMadeToast } from "./requestMadeToast";

/**
 * All, or one kind. The node takes `kind` on `/requests/search` and has since M6; nothing in the
 * app ever passed it, so every search was two lookups whether or not the person wanted both.
 */
const KIND_FILTERS = [
  { key: "all", kind: undefined, labelKey: "requests.filter_kind_all" },
  { key: "movie", kind: "movie", labelKey: "requests.filter_kind_films" },
  { key: "series", kind: "series", labelKey: "requests.filter_kind_series" },
] as const;

type KindKey = (typeof KIND_FILTERS)[number]["key"];

/**
 * Find something to ask for — the Requests tab's own search, on phone and web.
 *
 * This is where requesting lives. It was removed from here once, in favour of the Search tab
 * answering one box with both a library section and a catalogue section, and that turned out to be
 * two mistakes at once: the Request button was revealed only on hover, and the whole catalogue
 * section drew *nothing at all* when the node's lookup came back empty — so a member on the
 * Requests screen was shown a button that took them to a different tab where, on a node whose
 * managers were not configured, there was still nothing to press. See `docs/REQUESTS.md` §9.
 *
 * **The box belongs to this section, at every width.** For a while wide web had no input here at
 * all: the shell's top-bar box drove the `q` route param and this section read it back, to avoid
 * two places to type one title. It avoided that and bought something worse — a control sitting
 * above the tab bar, so it read as furniture for all six sections while driving exactly one; five
 * tabs it did nothing on; a box that quietly meant something different on this page than on every
 * other; and an empty state reduced to giving directions to a control ("type into the box at the
 * top of the screen"), which is a screen admitting its input is in the wrong place. There is still
 * only one place to type, solved the other way round: the top bar no longer touches this screen, so
 * it means one thing everywhere — Enter opens the Search tab (`components/shell/SearchField.tsx`).
 *
 * One box returns films and series together — the node asks both managers and answers films first —
 * with chips to narrow. Narrowing is a real re-query rather than a client-side hide, which is a
 * lookup the node does not have to make; React Query caches per `(term, kind)`, so coming back to
 * All is instant. The chips wait for a search to narrow: before there is a result set they are
 * three controls that do nothing, sitting on top of the empty state.
 *
 * Every result says what the *group* already thinks about it, which is the whole difference between
 * this and a Seerr: in a group that pools libraries the interesting answer is usually "somebody
 * already has this", and discovering that after pressing Request is too late to be useful.
 *
 * There is no feed before a search — no trending row, no recently-requested carousel — because no
 * endpoint answers either question. Six example chips stand in, and pressing one runs a real search
 * rather than showing a fabricated result.
 */
export function FindSection({ term = "" }: { term?: string }) {
  const { t } = useTranslation();
  const router = useRouter();

  // `term` is the `q` route param, which is an *entry* term rather than a mirror of this box:
  // Search's `Request "…"` button hands a title over with it (and `tab=find`), and nothing on this
  // screen writes it back. Seeding both halves means that handoff shows results straight away
  // instead of sitting empty through a debounce it never needed.
  const [typed, setTyped] = useState(term);
  const [debounced, setDebounced] = useState(term);
  const [kindKey, setKindKey] = useState<KindKey>("all");
  const [picking, setPicking] = useState<RequestSearchResult | null>(null);
  // Which row is waiting on the node, by item key, so one press spins one button. `create.isPending`
  // is per-mutation rather than per-row and would spin every button in the list at once.
  const [submitting, setSubmitting] = useState<string | null>(null);
  const create = useCreateRequest();

  /**
   * Ask for it.
   *
   * A movie goes straight to the node: there is nothing to decide, and the sheet that used to open
   * here only repeated the row back with a second Request button on it. A TV show opens the sheet,
   * because which seasons to ask for is a real choice — an empty selection means all of them, and
   * that default is worth showing rather than assuming silently.
   */
  const request = async (result: RequestSearchResult) => {
    if (result.kind === "series") {
      setPicking(result);
      return;
    }
    setSubmitting(result.itemKey);
    try {
      const made = await create.mutateAsync({
        tmdbId: result.tmdbId || undefined,
        tvdbId: result.tvdbId || undefined,
        title: result.title,
        year: result.year,
        posterUrl: result.posterUrl,
      });
      requestMadeToast(made, t);
    } catch (err) {
      // A toast, where the sheet had a `FormError` under its fields: there is no sheet left to
      // hold one, and the row itself must not grow a second height depending on whether the last
      // press worked.
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  };

  // Guarded on being different so a re-render cannot push a stale `q` back over what is being
  // typed now. Same shape, and the same reason, as the guard in `SearchField`.
  useEffect(() => {
    if (!term) return;
    setTyped((current) => (term === current ? current : term));
  }, [term]);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(typed),
      REQUEST_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [typed]);

  const kind = KIND_FILTERS.find((f) => f.key === kindKey)?.kind;
  const search = useRequestSearch(debounced, kind);
  const policy = useRequestPolicy();
  const canAdmin = useCanApproveRequests();
  // Off the key the Requests list already polls, so a title asked for a moment ago shows as
  // requested here without waiting for the node's own annotation to catch up.
  const mine = useRequests({ mine: true });

  const rows = useMemo(
    () => dedupeSearchResults(search.data ?? [], mine.data ?? []),
    [search.data, mine.data],
  );

  const searching = debounced.trim().length >= REQUEST_SEARCH_MIN_LENGTH;

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
          // Offered only to somebody who can act on it. Two different things land here: a real
          // no-match, and a node whose managers are off — `/requests/search` answers an empty list
          // for the second, not the 503 `RequestsErrorState` handles, which is why the copy has to
          // cover both. Movies & TV shows is the screen for the first and the more likely of the
          // two now that downloading is on by default: it is where a title search cannot find gets
          // added by hand, and its own empty state points on to the switch for the second.
          action={
            canAdmin
              ? {
                  label: t("home.settings.sections.arr_library"),
                  icon: "settings",
                  onPress: () => router.push("/settings/library"),
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
            pending={submitting === result.itemKey}
            onPress={() => request(result)}
          />
        ))}
      </View>
    );
  };

  return (
    <View>
      {/*
        Landing on Find puts the caret in the box. This section only exists while its tab is the
        open one — `?tab=find`, a press on the tab, or Search handing a title over — so mounting
        *is* landing, and every one of those arrivals is somebody who came here to type. Without
        it the first thing anyone does on this screen is click the only control on it.

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

      {searching ? (
        <View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              gap: 8,
              paddingTop: 12,
              paddingBottom: 12,
            }}
          >
            {KIND_FILTERS.map((entry) => (
              <FilterChip
                key={entry.key}
                label={t(entry.labelKey)}
                active={kindKey === entry.key}
                onPress={() => setKindKey(entry.key)}
              />
            ))}
          </ScrollView>
          {results()}
        </View>
      ) : (
        <View>
          <EmptyState
            icon='search'
            title={t("requests.discover_prompt_title")}
            detail={t("requests.discover_prompt_detail")}
          />
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              justifyContent: "center",
              paddingHorizontal: 24,
            }}
          >
            {REQUEST_EXAMPLE_SEARCHES.map((example) => (
              <Pill
                key={example}
                label={example}
                onPress={() => setTyped(example)}
              />
            ))}
          </View>
        </View>
      )}

      <RequestSheet result={picking} onClose={() => setPicking(null)} />
    </View>
  );
}
