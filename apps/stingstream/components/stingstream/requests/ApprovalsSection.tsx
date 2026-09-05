import { View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import {
  requestTitle,
  useDecideRequest,
  useRequests,
} from "@/lib/stingstream/requests";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { RequestRow, RowButton } from "./RequestPieces";

/**
 * The administrator's queue: everything waiting for a decision, plus anything that gave up.
 *
 * Failed requests are here rather than on a screen of their own because they need the same person
 * and usually the same one action. A request fails when no node could grab it — nobody had an
 * indexer for it, or the one that claimed it searched for six hours and found nothing — and Retry
 * puts it back in the queue for a group whose shape may since have changed.
 */
export function ApprovalsSection() {
  const pending = useRequests({ state: "pending" });
  const failed = useRequests({ state: "failed" });
  const decide = useDecideRequest();

  const act = async (
    id: string,
    decision: "approve" | "decline" | "retry",
    title: string,
  ) => {
    try {
      await decide.mutateAsync({ id, decision });
      toast.success(
        decision === "approve"
          ? `Approved ${title}`
          : decision === "decline"
            ? `Declined ${title}`
            : `Retrying ${title}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const waiting = pending.data ?? [];
  const givenUp = failed.data ?? [];

  return (
    <QueryState
      isLoading={pending.isLoading}
      error={pending.error}
      onRetry={pending.refetch}
    >
      <Text className='text-white text-lg font-semibold mb-2'>
        Waiting for you
      </Text>
      {waiting.length === 0 ? (
        <EmptyState
          title='Nothing waiting'
          detail='Requests that the group policy auto-approves never appear here. Change who needs approving under Policy.'
        />
      ) : (
        waiting.map((request) => (
          <RequestRow
            key={request.id}
            request={request}
            actions={
              <>
                <RowButton
                  label='Approve'
                  disabled={decide.isPending}
                  onPress={() =>
                    act(request.id, "approve", requestTitle(request))
                  }
                />
                <RowButton
                  label='Decline'
                  tone='danger'
                  disabled={decide.isPending}
                  onPress={() =>
                    act(request.id, "decline", requestTitle(request))
                  }
                />
              </>
            }
          />
        ))
      )}

      {givenUp.length > 0 ? (
        <View className='mt-4'>
          <Text className='text-white text-lg font-semibold mb-2'>
            Could not be filled
          </Text>
          {givenUp.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              actions={
                <RowButton
                  label='Try again'
                  disabled={decide.isPending}
                  onPress={() =>
                    act(request.id, "retry", requestTitle(request))
                  }
                />
              }
            />
          ))}
        </View>
      ) : null}
    </QueryState>
  );
}
