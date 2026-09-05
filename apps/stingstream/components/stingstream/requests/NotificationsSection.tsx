import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import {
  useMarkNotificationsRead,
  useRequestNotifications,
} from "@/lib/stingstream/requests";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { RowButton } from "./RequestPieces";

/**
 * What the node has been trying to tell this member.
 *
 * A request finishes hours later on a machine the requester does not own, usually while the app is
 * closed. The node also pushes a toast to any live session and writes Jellyfin's activity log, but
 * this polled list is the durable one — it is what somebody sees when they open the app the next
 * morning and want to know whether the thing they asked for on Sunday ever arrived.
 */
export function NotificationsSection() {
  const notifications = useRequestNotifications(false);
  const markRead = useMarkNotificationsRead();

  const rows = notifications.data ?? [];
  const unread = rows.filter((n) => !n.read);

  return (
    <QueryState
      isLoading={notifications.isLoading}
      error={notifications.error}
      onRetry={notifications.refetch}
    >
      {rows.length === 0 ? (
        <EmptyState
          title='Nothing to tell you'
          detail='You will be told here when a request is approved, declined, or lands in your library.'
        />
      ) : (
        <View>
          {unread.length > 0 ? (
            <View className='flex-row justify-end mb-2'>
              <RowButton
                label={`Mark ${unread.length} read`}
                tone='quiet'
                disabled={markRead.isPending}
                onPress={() => markRead.mutate([])}
              />
            </View>
          ) : null}

          <ListGroup>
            {rows.map((n) => (
              <ListItem
                key={n.id}
                title={n.title}
                subtitle={n.body}
                iconAfter={
                  n.read ? undefined : (
                    <View className='w-2 h-2 rounded-full bg-[#9334E9]' />
                  )
                }
              />
            ))}
          </ListGroup>

          <Text className='text-[#9899A1] text-xs mt-2'>
            The newest 200 are kept. The request itself is the durable record.
          </Text>
        </View>
      )}
    </QueryState>
  );
}
