import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
import { Text } from "@/components/common/Text";
import { FilterChip } from "@/components/filters/FilterChip";
import {
  type MemberRequest,
  type RequestState,
  requestAsSearchResult,
  requestTitle,
  selectMine,
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
 * What this member has asked for, and where each one got to.
 *
 * A block on Discover (`FindSection`), between the filters and the catalogue, rather than a tab of
 * its own. It was a tab, and the one Requests opened on, which meant every search began with a
 * press on a different tab. With nothing asked for yet it draws nothing at all: the catalogue under
 * it is already the answer to "find something", and an empty state saying so would only push that
 * catalogue down the page.
 *
 * The node already filters to the caller's own for a non-administrator, so `selectMine` is for the
 * administrator case only — an administrator's list is everybody's, and their own requests still
 * belong on their own screen. The state filter is client-side: the whole list is never more than a
 * few dozen rows, and a chip is cheaper to answer from what is already on screen than from a fresh
 * request to the node.
 */
export function MyRequestsSection() {
  const { t } = useTranslation();
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

  // Two rows, not a full list: this is a block above the catalogue, and a tall skeleton that turns
  // out to stand for nothing moves the whole catalogue a long way when it goes.
  if (requests.isLoading) return <RequestCardSkeletonList count={2} />;
  if (requests.error) {
    return (
      <RequestsErrorState error={requests.error} onRetry={requests.refetch} />
    );
  }

  if (mine.length === 0) return null;

  // Everything not finished: waiting, approved, downloading, declined, failed. Not the whole list —
  // a title that arrived is over, and a count of things nobody has to do anything about only ever
  // goes up, which is how a count stops being read. It was the My requests tab's badge.
  const open = mine.filter((request) => request.state !== "available").length;

  return (
    <View testID='requests-mine' style={{ marginBottom: 24 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          gap: 8,
          marginTop: 4,
          marginBottom: 8,
        }}
      >
        <Text variant='heading' weight='semibold'>
          {t("requests.tab_mine")}
        </Text>
        {open > 0 ? (
          <Text variant='caption' tone='secondary'>
            {open}
          </Text>
        ) : null}
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

      {/*
        The same sheet Find opens, reading the stored request through `requestAsSearchResult`. Both
        the overview and the season count are stored on the request for this, because the search
        result they came from is long gone by the time anybody edits it; a request made before
        those columns existed still falls back to the picker's generous range.
      */}
      <RequestSheet
        result={editing ? requestAsSearchResult(editing) : null}
        existing={editing}
        onClose={() => setEditing(null)}
      />
    </View>
  );
}
