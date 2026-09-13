import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { CardRow } from "@/components/cards/CardRow";
import { EmptyState } from "@/components/common/EmptyState";
import { Text } from "@/components/common/Text";
import { FilterChip } from "@/components/filters/FilterChip";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import {
  type MemberRequest,
  type RequestState,
  requestAsSearchResult,
  requestTitle,
  selectMine,
  toRequestCard,
  useCurrentUserId,
  useDeleteRequest,
  useRequests,
} from "@/lib/stingstream/requests";
import { confirmDestructive } from "../shared/confirm";
import { RequestCard, RequestCardSkeletonList } from "./RequestCard";
import { RequestSheet } from "./RequestSheet";
import { RequestsErrorState } from "./RequestsErrorState";

const FILTERS: { key: RequestState | "all"; labelKey: string }[] = [
  { key: "all", labelKey: "requests.filter_all" },
  { key: "pending", labelKey: "requests.filter_pending" },
  { key: "approved", labelKey: "requests.filter_approved" },
  { key: "fulfilling", labelKey: "requests.filter_fulfilling" },
  { key: "available", labelKey: "requests.filter_available" },
  { key: "declined", labelKey: "requests.filter_declined" },
  { key: "failed", labelKey: "requests.filter_failed" },
];

/**
 * What this member has asked for, and where each one got to. Two shapes, both on Discover.
 *
 * **`row`** sits between Discover's filters and its catalogue: one horizontal row of posters, each
 * with its state in the corner (`toRequestCard` puts `stateLabel` in `badgeLabel`). It was a list of
 * full rows for a day, and Dan, 2026-09-12: *"if I have 15 requests they are gonna fill up and I
 * wont see the discover"*. A row is the same height at two requests or fifteen. A poster opens that
 * request's sheet, which edits its seasons or deletes it, so nothing the list offered is out of
 * reach. With nothing asked for yet it draws nothing: the catalogue under it is already the answer
 * to "find something".
 *
 * **`list`** is what See all opens, in place of the catalogue rather than as a tab of its own: the
 * state chips, and Edit and Delete on every row. Back returns to the row.
 *
 * The node already filters to the caller's own for a non-administrator, so `selectMine` is for the
 * administrator case only — an administrator's list is everybody's, and their own requests still
 * belong on their own screen. The state filter is client-side: the whole list is never more than a
 * few dozen rows, and a chip is cheaper to answer from what is already on screen than from a fresh
 * request to the node.
 */
export function MyRequestsSection({
  variant,
  onSeeAll,
  onBack,
}: {
  variant: "row" | "list";
  onSeeAll?: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const { gutter } = useBreakpoint();
  const [filter, setFilter] = useState<RequestState | "all">("all");
  const requests = useRequests({ mine: true });
  const userId = useCurrentUserId();
  const remove = useDeleteRequest();
  const [editing, setEditing] = useState<MemberRequest | null>(null);

  const mine = useMemo(
    () => selectMine(requests.data, userId),
    [requests.data, userId],
  );
  const rows = useMemo(
    () => (filter === "all" ? mine : mine.filter((r) => r.state === filter)),
    [mine, filter],
  );
  const byId = useMemo(
    () => new Map(mine.map((request) => [request.id, request])),
    [mine],
  );
  // No hover disc: nothing on this row plays, and a press opens the request's sheet.
  const cards = useMemo(
    () =>
      mine.map((request) => ({
        ...toRequestCard(request),
        hoverGlyph: "none" as const,
      })),
    [mine],
  );

  const withdraw = async (id: string, title: string) => {
    const confirmed = await confirmDestructive(
      t("requests.delete_confirm_title", { title }),
      t("requests.delete_confirm_detail"),
      t("requests.delete_confirm_action"),
    );
    if (!confirmed) return;
    try {
      await remove.mutateAsync(id);
      toast.success(t("requests.delete_success", { title }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  // Everything not finished: waiting, approved, downloading, declined, failed. Not the whole list —
  // a title that arrived is over, and a count of things nobody has to do anything about only ever
  // goes up, which is how a count stops being read. It was the My requests tab's badge.
  const open = mine.filter((request) => request.state !== "available").length;
  // `flex: 1` because `SectionHeader` spaces its children apart: without it the count floated
  // halfway between the heading and See all instead of sitting beside the heading it counts.
  const count = (
    <Text variant='caption' tone='secondary' style={{ flex: 1, marginLeft: 8 }}>
      {open > 0 ? open : ""}
    </Text>
  );

  /*
    The same sheet Find opens, reading the stored request through `requestAsSearchResult`. Both the
    overview and the season count are stored on the request for this, because the search result
    they came from is long gone by the time anybody edits it; a request made before those columns
    existed still falls back to the picker's generous range.
  */
  const sheet = (
    <RequestSheet
      result={editing ? requestAsSearchResult(editing) : null}
      existing={editing}
      onClose={() => setEditing(null)}
    />
  );

  if (variant === "row") {
    // Nothing at all on a failed fetch: a full error panel above the catalogue would push it down
    // for a list the reader did not ask to see. See all still reports what broke.
    if (requests.error) return null;
    return (
      // `CardRow` pads itself with the page gutter, and this sits inside a page that already has
      // one, so it bleeds back out by the same amount, as `RequestDiscoverGrid` does.
      <View
        testID='requests-mine'
        style={{ marginHorizontal: -gutter, marginBottom: 16 }}
      >
        <CardRow
          kind='portrait'
          title={t("requests.tab_mine")}
          headerAccessory={count}
          seeAllLabel={t("common.seeAll")}
          onPressSeeAll={onSeeAll}
          seeAllTestID='requests-mine-see-all'
          cards={cards}
          loading={requests.isLoading}
          hideIfEmpty
          onPressId={(id) => {
            const request = byId.get(id);
            if (request) setEditing(request);
          }}
        />
        {sheet}
      </View>
    );
  }

  const back = onBack ? (
    <View style={{ alignItems: "flex-start", marginBottom: 8 }}>
      <Button
        variant='ghost'
        size='sm'
        icon='chevronLeft'
        onPress={onBack}
        testID='requests-mine-back'
      >
        {t("common.back")}
      </Button>
    </View>
  ) : null;

  if (requests.isLoading) {
    return (
      <View>
        {back}
        <RequestCardSkeletonList />
      </View>
    );
  }
  if (requests.error) {
    return (
      <View>
        {back}
        <RequestsErrorState error={requests.error} onRetry={requests.refetch} />
      </View>
    );
  }

  return (
    <View testID='requests-mine-list'>
      {back}
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <Text variant='heading' weight='semibold'>
          {t("requests.tab_mine")}
        </Text>
        {count}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingBottom: 12 }}
      >
        {FILTERS.map((entry) => (
          <FilterChip
            key={entry.key}
            label={t(entry.labelKey)}
            active={filter === entry.key}
            onPress={() => setFilter(entry.key)}
          />
        ))}
      </ScrollView>

      {rows.length === 0 ? (
        <EmptyState
          icon='requests'
          title={t("requests.my_filter_empty_title")}
        />
      ) : (
        <View>
          {rows.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              // The poster and the title open it, the same as they do on Find.
              onOpen={() => setEditing(request)}
              actions={
                // Withdrawing a request that is already fulfilled does not stop the download — the
                // grabbing node may be somebody else's and is already committed — but it does take
                // it off this list, which is what "I no longer want this" means from here.
                request.state === "available" ? undefined : (
                  <>
                    {/*
                      On every row, not only the ones with seasons to change. It used to be gated on
                      the request still being open *or* this node's manager tracking the title,
                      which meant three rows in the same state — three movies nobody could grab —
                      showed Edit on the one that happened to have been added here and nothing on
                      the other two. A list where the buttons come and go by something the reader
                      cannot see reads as broken, and the sheet always has something to offer:
                      the seasons, what this server does about the title, or asking for it again.
                    */}
                    <Button
                      variant='secondary'
                      size='sm'
                      icon='settings'
                      onPress={() => setEditing(request)}
                    >
                      {t("requests.edit_button")}
                    </Button>
                    <Button
                      variant='danger'
                      size='sm'
                      icon='delete'
                      disabled={remove.isPending}
                      onPress={() =>
                        withdraw(request.id, requestTitle(request))
                      }
                    >
                      {t("requests.delete_action")}
                    </Button>
                  </>
                )
              }
            />
          ))}
        </View>
      )}

      {sheet}
    </View>
  );
}
