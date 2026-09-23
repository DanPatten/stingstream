import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
import { Text } from "@/components/common/Text";
import { RequestListFilterBar } from "@/components/filters/RequestListFilterBar";
import {
  requestTitle,
  useDecideRequest,
  useRequests,
} from "@/lib/stingstream/requests";
import { RequestCard, RequestCardSkeletonList } from "./RequestCard";
import { RequestsErrorState } from "./RequestsErrorState";
import { RequestsFilteredEmpty } from "./RequestsFilteredEmpty";
import {
  applyRequestListFilters,
  DEFAULT_REQUEST_LIST_FILTERS,
  type RequestListFilters,
  requesterOptions,
  requestListFiltersActive,
} from "./requestListFilters";

/**
 * The administrator's queue: everything waiting for a decision, plus anything that gave up.
 *
 * Failed requests are here rather than on a screen of their own because they need the same person
 * and usually the same one action. A request fails when no node could grab it — nobody had an
 * indexer for it, or the one that claimed it searched for hours and found nothing — and Retry puts
 * it back in the queue for a group whose shape may since have changed.
 *
 * One filter bar over both halves (type, who asked, order), from the route through
 * `RequestsScreen`. No status chip: each half is already one state.
 */
export function ApprovalsSection({
  filters = DEFAULT_REQUEST_LIST_FILTERS,
  onFilters,
}: {
  filters?: RequestListFilters;
  onFilters?: (filters: RequestListFilters) => void;
} = {}) {
  const { t } = useTranslation();
  const pending = useRequests({ state: "pending" });
  const failed = useRequests({ state: "failed" });
  const decide = useDecideRequest();

  const allWaiting = pending.data ?? [];
  const allGivenUp = failed.data ?? [];
  const requesters = useMemo(
    () => requesterOptions([...(pending.data ?? []), ...(failed.data ?? [])]),
    [pending.data, failed.data],
  );
  const waiting = useMemo(
    () => applyRequestListFilters(pending.data ?? [], filters),
    [pending.data, filters],
  );
  const givenUp = useMemo(
    () => applyRequestListFilters(failed.data ?? [], filters),
    [failed.data, filters],
  );
  const filtered = requestListFiltersActive(filters);
  const clear = () => onFilters?.(DEFAULT_REQUEST_LIST_FILTERS);

  // Drawn over the skeleton too, so the rows land where the placeholders were.
  const bar = (
    <RequestListFilterBar
      section='approvals'
      filters={filters}
      set={(next) => onFilters?.(next)}
      requesters={requesters}
      shown={waiting.length + givenUp.length}
      total={allWaiting.length + allGivenUp.length}
    />
  );

  const act = async (
    id: string,
    decision: "approve" | "decline" | "retry",
    title: string,
  ) => {
    try {
      await decide.mutateAsync({ id, decision });
      toast.success(
        decision === "approve"
          ? t("requests.approved", { title })
          : decision === "decline"
            ? t("requests.declined", { title })
            : t("requests.retrying", { title }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  if (pending.isLoading) {
    return (
      <View>
        {bar}
        <Text variant='heading' weight='semibold' style={{ marginBottom: 10 }}>
          {t("requests.approvals_waiting_title")}
        </Text>
        <RequestCardSkeletonList />
      </View>
    );
  }
  if (pending.error) {
    return (
      <RequestsErrorState error={pending.error} onRetry={pending.refetch} />
    );
  }

  // Filters that empty both halves say so once, rather than under each heading.
  if (filtered && waiting.length === 0 && givenUp.length === 0) {
    return (
      <View testID='requests-list'>
        {bar}
        <RequestsFilteredEmpty onClear={clear} />
      </View>
    );
  }

  return (
    <View testID='requests-list'>
      {bar}
      <Text variant='heading' weight='semibold' style={{ marginBottom: 10 }}>
        {t("requests.approvals_waiting_title")}
      </Text>
      {waiting.length === 0 && filtered && allWaiting.length > 0 ? (
        <RequestsFilteredEmpty onClear={clear} />
      ) : waiting.length === 0 ? (
        <EmptyState
          icon='requests'
          title={t("requests.approvals_empty_title")}
          detail={t("requests.approvals_empty_detail")}
        />
      ) : (
        waiting.map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            actions={
              <>
                <Button
                  variant='ghost'
                  size='sm'
                  icon='check'
                  disabled={decide.isPending}
                  onPress={() =>
                    act(request.id, "approve", requestTitle(request))
                  }
                >
                  {t("requests.approve_button")}
                </Button>
                <Button
                  variant='danger'
                  size='sm'
                  icon='close'
                  disabled={decide.isPending}
                  onPress={() =>
                    act(request.id, "decline", requestTitle(request))
                  }
                >
                  {t("requests.decline_button")}
                </Button>
              </>
            }
          />
        ))
      )}

      {givenUp.length > 0 ? (
        <View style={{ marginTop: 20 }}>
          <Text
            variant='heading'
            weight='semibold'
            style={{ marginBottom: 10 }}
          >
            {t("requests.approvals_failed_title")}
          </Text>
          {givenUp.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              actions={
                <>
                  <Button
                    variant='ghost'
                    size='sm'
                    icon='refresh'
                    disabled={decide.isPending}
                    onPress={() =>
                      act(request.id, "retry", requestTitle(request))
                    }
                  >
                    {t("common.retry")}
                  </Button>
                  {/*
                    A request fails *after* the title was added, often enough: the manager has it,
                    monitored, with nothing to grab. Retry asks again; this is how the same person
                    stops asking, or changes the quality it is looking for. Draws nothing when this
                    node's manager never took the title.
                  */}
                </>
              }
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
