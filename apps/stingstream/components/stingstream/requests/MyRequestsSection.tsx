import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
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
                      which meant three rows in the same state — three films nobody could grab —
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
                      {t("common.delete")}
                    </Button>
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
