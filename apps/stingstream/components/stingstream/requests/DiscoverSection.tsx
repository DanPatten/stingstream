import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWindowDimensions, View } from "react-native";
import { useCardGrid } from "@/components/cards/useCardGrid";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/common/Input";
import { SkeletonGrid } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { REQUEST_SEARCH_DEBOUNCE_MS } from "@/constants/Requests";
import { maxWidth as MAX_WIDTHS } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import {
  DEFAULT_REQUEST_FILTERS,
  type RequestSearchResult,
  toRequestCard,
  useRequestDiscover,
  useRequestPolicy,
  useRequestSearch,
} from "@/lib/stingstream/requests";
import { RequestDiscoverGrid } from "./RequestDiscoverGrid";
import { RequestSheet } from "./RequestSheet";
import { RequestsErrorState } from "./RequestsErrorState";

/**
 * Find something to ask for — **on a television only**, since F-73.
 *
 * Phone and web ask from Search now: one box runs the library search and this same catalogue
 * search at once and groups the answers ("In your library" / "Not in your library"), which is the
 * whole of what a person means by "find it and request it if it isn't there". The TV search screen
 * is a different screen with a different input and a remote control to type on, so it keeps this
 * section behind its own Discover tab (`TVRequestsScreen`) rather than growing the same two-section
 * result list.
 *
 * The search goes through the node's own Radarr and Sonarr metadata lookups rather than a metadata
 * provider of the app's own, and every result comes back annotated with whether the *group* already
 * holds it. That annotation is the whole difference between this and the Seerr screen it replaces:
 * in a group that pools libraries, the interesting answer is usually "you already have this", and
 * discovering that only after pressing Request is too late to be useful — so it is a corner badge
 * on the poster itself (`toRequestCard`/`searchBadgeLabel`), not something a tap reveals.
 *
 * With nothing typed it draws the catalogue, the same feed the phone and web screen opens on: the
 * most popular titles, as posters, which is the one thing a ten-foot screen is genuinely better at
 * than a phone. It has no filter bar. Those chips open a sheet, and a television filters through
 * `TVFilterButton` and its own full-screen picker instead — worth doing, and worth doing properly
 * rather than by dropping a phone control onto a remote control.
 */
export function DiscoverSection() {
  const { t } = useTranslation();
  const { gutter } = useBreakpoint();
  const { width: windowWidth } = useWindowDimensions();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picking, setPicking] = useState<RequestSearchResult | null>(null);

  const policy = useRequestPolicy();
  const search = useRequestSearch(debounced);
  const discover = useRequestDiscover(DEFAULT_REQUEST_FILTERS);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(term),
      REQUEST_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [term]);

  const results = search.data ?? [];
  const byKey = useMemo(
    () => new Map(results.map((result) => [result.itemKey, result])),
    [results],
  );
  const cards = useMemo(() => results.map(toRequestCard), [results]);

  // The same width `PageContainer width="media"` would render at, measured rather than assumed:
  // the requests screen sits inside the web shell's sidebar+topbar content pane, whose width is
  // not the full browser window, so `useWindowDimensions()` alone would overcount at web-wide.
  const containerWidth = Math.min(windowWidth, MAX_WIDTHS.media) + gutter * 2;

  const grid = useCardGrid({
    cards,
    kind: "portrait",
    containerWidth,
    onPressId: (id) => {
      const result = byKey.get(id);
      if (result) setPicking(result);
    },
  });

  const showingSearch = debounced.trim().length > 2;

  return (
    <View>
      <Input
        testID='requests-search'
        value={term}
        onChangeText={setTerm}
        placeholder={t("requests.search_placeholder")}
        icon='search'
        autoCorrect={false}
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

      <View style={{ height: 16 }} />

      {!showingSearch ? (
        <RequestDiscoverGrid
          results={discover.data?.results ?? []}
          loading={discover.isLoading}
          onPress={setPicking}
        />
      ) : search.isLoading ? (
        <SkeletonGrid kind='portrait' columns={grid.columns} />
      ) : search.error ? (
        <RequestsErrorState error={search.error} onRetry={search.refetch} />
      ) : results.length === 0 ? (
        <EmptyState
          icon='search'
          title={t("requests.discover_empty_title")}
          detail={t("requests.discover_empty_detail", {
            term: debounced.trim(),
          })}
        />
      ) : (
        <View
          testID='requests-grid'
          style={{
            marginHorizontal: -gutter,
            flexDirection: "row",
            flexWrap: "wrap",
          }}
        >
          {grid.data.map((item, index) => (
            <Fragment key={item.id}>
              {grid.renderItem({ item, index })}
            </Fragment>
          ))}
        </View>
      )}

      <RequestSheet result={picking} onClose={() => setPicking(null)} />
    </View>
  );
}
