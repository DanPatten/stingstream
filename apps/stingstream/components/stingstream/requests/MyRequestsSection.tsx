import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
import { FilterChip } from "@/components/filters/FilterChip";
import type { ArrMovie, ArrSeries } from "@/lib/stingstream/arr-types";
import { useMovies, useSeries } from "@/lib/stingstream/hooks";
import {
  type MemberRequest,
  type RequestState,
  requestAsSearchResult,
  requestTitle,
  selectMine,
  useCanApproveRequests,
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
 * The node already filters to the caller's own for a non-administrator, so `selectMine` is for the
 * administrator case only — an administrator's list is everybody's, and their own requests still
 * belong on their own screen. The state filter is client-side: the whole list is never more than a
 * few dozen rows, and a chip is cheaper to answer from what is already on screen than from a fresh
 * request to the node.
 *
 * `onFind` switches the screen to its own Find section. It used to be a `router.replace("/search")`
 * — the empty state's only offer was to leave for another tab, which is what made this screen look
 * like it could not do the one thing it is for.
 */
export function MyRequestsSection({ onFind }: { onFind?: () => void }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<RequestState | "all">("all");
  const requests = useRequests({ mine: true });
  const userId = useCurrentUserId();
  const remove = useDeleteRequest();
  const [editing, setEditing] = useState<MemberRequest | null>(null);
  // The two lists `useArrTitle` reads, asked for once here rather than per row: they are shared
  // React Query entries, so this costs one fetch however many rows are on screen.
  const isAdmin = useCanApproveRequests();
  const movies = useMovies(isAdmin);
  const series = useSeries(isAdmin);
  const tracked = useMemo(
    () => ({
      movies: new Set(
        ((movies.data ?? []) as ArrMovie[]).map((row) => row.tmdbId),
      ),
      series: new Set(
        ((series.data ?? []) as ArrSeries[]).map((row) => row.tvdbId),
      ),
    }),
    [movies.data, series.data],
  );

  /**
   * Whether Edit has anything to offer for this row.
   *
   * Two halves, and either is enough. The seasons can change while the request is open. What this
   * server does about the title — monitoring, quality, removal — applies for as long as its manager
   * tracks the title, which outlives the request: a film that failed to grab is still tracked, and
   * gating on the request alone is what left a failed film with no Edit beside a downloading show
   * that had one. Dan: *"make sure movies and tv shows get the same edit treatment."*
   */
  const editableRow = (request: MemberRequest) =>
    stillOpen(request) ||
    (request.kind === "series"
      ? tracked.series.has(request.providerId)
      : tracked.movies.has(request.providerId));

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
      t("common.delete"),
    );
    if (!confirmed) return;
    try {
      await remove.mutateAsync(id);
      toast.success(t("requests.delete_success", { title }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  if (requests.isLoading) return <RequestCardSkeletonList />;
  if (requests.error) {
    return (
      <RequestsErrorState error={requests.error} onRetry={requests.refetch} />
    );
  }

  if (mine.length === 0) {
    return (
      <EmptyState
        icon='requests'
        title={t("requests.my_empty_title")}
        detail={t("requests.my_empty_detail")}
        action={
          onFind
            ? {
                label: t("requests.my_empty_action"),
                icon: "search",
                onPress: onFind,
              }
            : undefined
        }
      />
    );
  }

  return (
    <View>
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
              onOpen={
                editableRow(request) ? () => setEditing(request) : undefined
              }
              actions={
                // Withdrawing a request that is already fulfilled does not stop the download — the
                // grabbing node may be somebody else's and is already committed — but it does take
                // it off this list, which is what "I no longer want this" means from here.
                request.state === "available" ? undefined : (
                  <>
                    {/*
                      Offered when there is something the sheet can actually change: the seasons,
                      while the request is open, or what this server does about the title, for as
                      long as its manager tracks it. A film that failed to grab is still tracked,
                      and monitoring, quality and removal all still apply to it — which is why this
                      is not simply "is the request open".
                    */}
                    {editableRow(request) ? (
                      <Button
                        variant='secondary'
                        size='sm'
                        icon='settings'
                        onPress={() => setEditing(request)}
                      >
                        {t("requests.edit_button")}
                      </Button>
                    ) : null}
                    <Button
                      variant='danger'
                      size='sm'
                      icon='delete'
                      disabled={remove.isPending}
                      onPress={() =>
                        withdraw(request.id, requestTitle(request))
                      }
                    >
                      {t("common.delete")}
                    </Button>
                    {/*
                      Draws nothing unless this node's manager is tracking the title. Delete above
                      withdraws the *request*; this is the only thing in the app that can undo the
                      add itself while the title has no library page of its own to carry it.
                    */}
                  </>
                )
              }
            />
          ))}
        </View>
      )}

      {/*
        The same sheet Find opens, reading the stored request through `requestAsSearchResult`. It
        carries no overview and no season count — nothing asked TVDB how long the show was when the
        request was made — so the sheet shows the title, the poster it stored, and the picker's
        fallback range.
      */}
      <RequestSheet
        result={editing ? requestAsSearchResult(editing) : null}
        existing={editing}
        onClose={() => setEditing(null)}
      />
    </View>
  );
}

/**
 * A request whose seasons can still be changed.
 *
 * The node answers 409 for one that has finished, and this is the same rule read from the other
 * side. It is only half of whether Edit is offered — see `editableRow`.
 */
const stillOpen = (request: MemberRequest) =>
  request.state === "pending" ||
  request.state === "approved" ||
  request.state === "fulfilling";
