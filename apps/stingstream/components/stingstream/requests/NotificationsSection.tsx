import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/common/EmptyState";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  useMarkNotificationsRead,
  useRequestNotifications,
} from "@/lib/stingstream/requests";
import { RequestCardSkeletonList } from "./RequestCard";
import { RequestsErrorState } from "./RequestsErrorState";

/**
 * What the node has been trying to tell this member.
 *
 * A request finishes hours later on a machine the requester does not own, usually while the app is
 * closed. The node also pushes a toast to any live session and writes Jellyfin's activity log, but
 * this polled list is the durable one — it is what somebody sees when they open the app the next
 * morning and want to know whether the thing they asked for on Sunday ever arrived.
 */
export function NotificationsSection() {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const notifications = useRequestNotifications(false);
  const markRead = useMarkNotificationsRead();

  if (notifications.isLoading) return <RequestCardSkeletonList count={3} />;
  if (notifications.error) {
    return (
      <RequestsErrorState
        error={notifications.error}
        onRetry={notifications.refetch}
      />
    );
  }

  const rows = notifications.data ?? [];
  const unread = rows.filter((n) => !n.read);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon='requests'
        title={t("requests.alerts_empty_title")}
        detail={t("requests.alerts_empty_detail")}
      />
    );
  }

  return (
    <View>
      {unread.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            marginBottom: 8,
          }}
        >
          <Button
            variant='ghost'
            size='sm'
            icon='check'
            disabled={markRead.isPending}
            onPress={() => markRead.mutate([])}
          >
            {t("requests.mark_all_read", { count: unread.length })}
          </Button>
        </View>
      ) : null}

      <ListGroup>
        {rows.map((n) => (
          <ListItem key={n.id} title={n.title} subtitle={n.body}>
            {n.read ? null : (
              <View
                accessibilityLabel={t("requests.unread")}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: radius.pill,
                  backgroundColor: accent[500],
                }}
              />
            )}
          </ListItem>
        ))}
      </ListGroup>

      <Text variant='micro' tone='tertiary' style={{ marginTop: 8 }}>
        {t("requests.alerts_kept_note")}
      </Text>
    </View>
  );
}
