import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWindowDimensions, View } from "react-native";
import { useCardGrid } from "@/components/cards/useCardGrid";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/common/Input";
import { Pill } from "@/components/common/Pill";
import { SkeletonGrid } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { maxWidth as MAX_WIDTHS } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import {
  type RequestSearchResult,
  toRequestCard,
  useRequestPolicy,
  useRequestSearch,
} from "@/lib/stingstream/requests";
import { RequestSheet } from "./RequestSheet";
import { RequestsErrorState } from "./RequestsErrorState";

/** Every keystroke here costs the node two metadata lookups and a group-index scan per result.
 * Long enough that typing a title is one search, short enough not to feel stuck. */
const SEARCH_DEBOUNCE_MS = 400;

/** Public-domain titles WP-TOOLS seeds by default (`tools/ui-seed-media.ps1`), so an example
 * chip is guaranteed to find something real in every environment this screen is checked in,
 * verification node included. Six, per the design: enough to suggest a spread of films and one
 * series without turning the empty state into a wall of buttons. */
const EXAMPLE_SEARCHES = [
  "Sintel",
  "Big Buck Bunny",
  "Nosferatu",
  "The Beverly Hillbillies",
  "Tears of Steel",
  "Elephants Dream",
];

/**
 * Find something to ask for.
 *
 * The search goes through the node's own Radarr and Sonarr metadata lookups rather than a metadata
 * provider of the app's own, and every result comes back annotated with whether the *group* already
 * holds it. That annotation is the whole difference between this and the Seerr screen it replaces:
 * in a group that pools libraries, the interesting answer is usually "you already have this", and
 * discovering that only after pressing Request is too late to be useful — so it is a corner badge
 * on the poster itself (`toRequestCard`/`searchBadgeLabel`), not something a tap reveals.
 *
 * There is no feed here before a search — no "trending" row, no "recently requested" carousel —
 * because no endpoint answers either question. Six example chips stand in for a feed, and pressing
 * one runs a real search rather than showing a fabricated result.
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

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term), SEARCH_DEBOUNCE_MS);
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

      {policy.data && policy.data.autoApprove !== "everyone" ? (
        <Text variant='caption' tone='secondary' style={{ marginTop: 10 }}>
          {policy.data.autoApprove === "admins_only"
            ? t("requests.policy_hint_admins_only")
            : t("requests.policy_hint_trusted")}
        </Text>
      ) : null}

      <View style={{ height: 16 }} />

      {!showingSearch ? (
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
            {EXAMPLE_SEARCHES.map((example) => (
              <Pill
                key={example}
                label={example}
                onPress={() => setTerm(example)}
              />
            ))}
          </View>
        </View>
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
