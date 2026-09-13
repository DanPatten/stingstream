import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
import { SectionHeader } from "@/components/common/SectionHeader";
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
import { RequestPosterGrid } from "./RequestPosterGrid";
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
 * What this member has asked for, and where each one got to. Two shapes.
 *
 * **`row`** is on Discover, between its filters and its catalogue: the first line of the same poster
 * grid the catalogue uses, each poster with its state in the corner (`toRequestCard` puts
 * `stateLabel` in `badgeLabel`). One line, because full rows here put fifteen requests between the
 * reader and the catalogue (Dan, 2026-09-12: *"if I have 15 requests they are gonna fill up and I
 * wont see the discover"*). The catalogue's own cells, because a horizontal `CardRow` sized its
 * posters on its own scale and sat out of step with the grid under it (*"my reuqests are mis aligned
 * with the grid below it"*). A poster opens that request's sheet, which edits its seasons or deletes
 * it; See all opens the My requests tab. With nothing asked for yet it draws nothing.
 *
 * **`list`** is the My requests tab: the state chips, and Edit and Delete on every row.
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
}: {
  variant: "row" | "list";
  onSeeAll?: () => void;
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
  const cards = useMemo(() => mine.map(toRequestCard), [mine]);

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
  // goes up, which is how a count stops being read.
  const open = mine.filter((request) => request.state !== "available").length;

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
    // for a list the reader did not ask to see. The My requests tab still reports what broke.
    if (requests.error) return null;
    if (!requests.isLoading && mine.length === 0) return null;
    return (
      <View testID='requests-mine' style={{ marginBottom: 16 }}>
        {/*
          `SectionHeader` pads itself with the page gutter, and this sits inside a page that already
          has one, so it bleeds back out by the same amount: the heading then starts where the first
          poster does, which is where the grid below puts its own.
        */}
        <View style={{ marginHorizontal: -gutter }}>
          <SectionHeader
            title={t("requests.tab_mine")}
            accessory={
              // `flex: 1` because `SectionHeader` spaces its children apart: without it the count
              // floated halfway between the heading and See all.
              <Text
                variant='caption'
                tone='secondary'
                style={{ flex: 1, marginLeft: 8 }}
              >
                {open > 0 ? open : ""}
              </Text>
            }
            actionLabel={t("common.seeAll")}
            onPressAction={onSeeAll}
            actionTestID='requests-mine-see-all'
          />
        </View>
        <RequestPosterGrid
          cards={cards}
          loading={requests.isLoading}
          lines={1}
          // More than fit on the line: the last cell says how many, and opens the tab with them all.
          onMore={onSeeAll}
          testID='requests-mine-grid'
          cardTestID='requests-mine-card'
          onPressId={(id) => {
            const request = byId.get(id);
            if (request) setEditing(request);
          }}
        />
        {sheet}
      </View>
    );
  }

  if (requests.isLoading) return <RequestCardSkeletonList />;
  if (requests.error) {
    return (
      <RequestsErrorState error={requests.error} onRetry={requests.refetch} />
    );
  }

  if (mine.length === 0) {
    return (
      <EmptyState icon='requests' title={t("requests.my_filter_empty_title")} />
    );
  }

  return (
    <View testID='requests-mine-list'>
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
        <View testID='requests-list'>
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
