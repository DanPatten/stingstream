import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
import { FilterChip } from "@/components/filters/FilterChip";
import useRouter from "@/hooks/useAppRouter";
import {
  type RequestState,
  requestTitle,
  selectMine,
  useCurrentUserId,
  useDeleteRequest,
  useRequests,
} from "@/lib/stingstream/requests";
import { confirmDestructive } from "../shared/confirm";
import { RequestCard, RequestCardSkeletonList } from "./RequestCard";
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
 */
export function MyRequestsSection() {
  const { t } = useTranslation();
  const router = useRouter();
  const [filter, setFilter] = useState<RequestState | "all">("all");
  const requests = useRequests({ mine: true });
  const userId = useCurrentUserId();
  const remove = useDeleteRequest();

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
        action={{
          label: t("requests.my_empty_action"),
          icon: "search",
          // The section's own URL, the same one the sidebar and the tab bar
          // navigate to (`tabIcons.ts` TAB_PATHS): the group path renders
          // Search but leaves the address bar on `/`, which is pass-02's F-20
          // all over again. `replace`, not `push`, because Search is a tab
          // root like this one and the shell is one stack of tab groups.
          onPress: () => router.replace("/search"),
        }}
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
              actions={
                // Withdrawing a request that is already fulfilled does not stop the download — the
                // grabbing node may be somebody else's and is already committed — but it does take
                // it off this list, which is what "I no longer want this" means from here.
                request.state === "available" ? undefined : (
                  <Button
                    variant='danger'
                    size='sm'
                    icon='delete'
                    disabled={remove.isPending}
                    onPress={() => withdraw(request.id, requestTitle(request))}
                  >
                    {t("common.delete")}
                  </Button>
                )
              }
            />
          ))}
        </View>
      )}
    </View>
  );
}
