import { View } from "react-native";
import { toast } from "sonner-native";
import {
  requestTitle,
  selectMine,
  useCurrentUserId,
  useDeleteRequest,
  useRequests,
} from "@/lib/stingstream/requests";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { RequestRow, RowButton } from "./RequestPieces";

/**
 * What this member has asked for, and where each one got to.
 *
 * The node already filters to the caller's own for a non-administrator, so the client-side filter
 * is for the administrator case only — an administrator's list is everybody's, and their own
 * requests still belong on their own screen.
 */
export function MyRequestsSection() {
  const requests = useRequests({ mine: true });
  const userId = useCurrentUserId();
  const remove = useDeleteRequest();

  const mine = selectMine(requests.data, userId);

  const withdraw = async (id: string, title: string) => {
    try {
      await remove.mutateAsync(id);
      toast.success(`Withdrew ${title}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <QueryState
      isLoading={requests.isLoading}
      error={requests.error}
      onRetry={requests.refetch}
    >
      {mine.length === 0 ? (
        <EmptyState
          title='You have not asked for anything yet'
          detail='Search on the Discover tab. Anything your group already holds is marked so you do not ask for a download that would not happen.'
        />
      ) : (
        <View>
          {mine.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              actions={
                // Withdrawing a request that is already being fulfilled does not stop the
                // download -- the grabbing node may be somebody else's and is already committed --
                // but it does take it off this list, which is what "I no longer want this" means
                // from the requester's side.
                request.state === "available" ? undefined : (
                  <RowButton
                    label='Withdraw'
                    tone='danger'
                    disabled={remove.isPending}
                    onPress={() => withdraw(request.id, requestTitle(request))}
                  />
                )
              }
            />
          ))}
        </View>
      )}
    </QueryState>
  );
}
