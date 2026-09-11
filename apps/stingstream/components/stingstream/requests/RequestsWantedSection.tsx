import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
import { Text } from "@/components/common/Text";
import {
  requestTitle,
  useDecideRequest,
  useRequests,
} from "@/lib/stingstream/requests";
import { RequestCard, RequestCardSkeletonList } from "./RequestCard";
import { RequestsErrorState } from "./RequestsErrorState";

/**
 * What people want, on a server that fetches nothing by itself.
 *
 * Takes the Approvals tab's place when no indexer is configured. There is nothing to approve then:
 * approving would authorise a download that is never going to start. So this is a list of jobs
 * rather than a queue of decisions, and each row closes itself the moment the library serves that
 * title, however the administrator got hold of it.
 *
 * No Approve, no Retry, and no failed list: nothing is trying, so nothing can fail. Dismiss is the
 * one action, for something that is never going to be added. It is the same call behind Decline,
 * which is deliberate. Making people live with a list they cannot clear turns the one screen that
 * is supposed to say what to do next into a pile.
 */
export function RequestsWantedSection() {
  const { t } = useTranslation();
  const wanted = useRequests({ state: "wanted" });
  const decide = useDecideRequest();

  const dismiss = async (id: string, title: string) => {
    try {
      await decide.mutateAsync({ id, decision: "decline" });
      toast.success(t("requests.declined", { title }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  if (wanted.isLoading) return <RequestCardSkeletonList />;
  if (wanted.error) {
    return <RequestsErrorState error={wanted.error} onRetry={wanted.refetch} />;
  }

  const rows = wanted.data ?? [];

  return (
    <View testID='requests-list'>
      <Text variant='heading' weight='semibold' style={{ marginBottom: 10 }}>
        {t("requests.wanted_heading")}
      </Text>
      {rows.length === 0 ? (
        <EmptyState
          icon='requests'
          title={t("requests.wanted_empty_title")}
          detail={t("requests.wanted_empty_detail")}
        />
      ) : (
        rows.map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            actions={
              <Button
                variant='ghost'
                size='sm'
                icon='close'
                disabled={decide.isPending}
                onPress={() => dismiss(request.id, requestTitle(request))}
              >
                {t("requests.dismiss_action")}
              </Button>
            }
          />
        ))
      )}
    </View>
  );
}
