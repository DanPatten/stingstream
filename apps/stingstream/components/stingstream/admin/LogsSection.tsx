import { getSystemApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { apiAtom } from "@/providers/JellyfinProvider";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";

function formatSize(bytes?: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** exp).toFixed(1)} ${units[exp]}`;
}

export function LogsSection() {
  const { color } = useTheme();
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const [openLog, setOpenLog] = useState<string | null>(null);

  const {
    data: logs,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["stingstream", "jellyfin-logs"],
    queryFn: async () => {
      const res = await getSystemApi(api!).getServerLogs();
      return res.data;
    },
    enabled: !!api,
  });

  const { data: logContent, isLoading: contentLoading } = useQuery({
    queryKey: ["stingstream", "jellyfin-log-content", openLog],
    queryFn: async () => {
      const res = await getSystemApi(api!).getLogFile({ name: openLog! });
      return res.data as unknown as string;
    },
    enabled: !!api && !!openLog,
  });

  if (openLog) {
    return (
      <View>
        <Pressable
          onPress={() => setOpenLog(null)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <Icon name='chevronLeft' size={16} tone='accent' />
          <Text tone='accent' weight='semibold' style={{ marginLeft: 2 }}>
            {t("admin.logs_back_action")}
          </Text>
        </Pressable>
        <Text weight='semibold' style={{ marginBottom: 8 }}>
          {openLog}
        </Text>
        <ScrollView
          horizontal
          style={{
            borderRadius: radius.md,
            backgroundColor: color.bg["1"],
            maxHeight: 500,
          }}
          contentContainerStyle={{ padding: 12 }}
        >
          <Text
            variant='caption'
            tone='secondary'
            selectable
            style={{ fontFamily: "monospace" }}
          >
            {contentLoading ? t("admin.logs_loading") : (logContent ?? "")}
          </Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View>
      <ScreenHeaderRow title={t("admin.logs_title")} />
      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!logs || logs.length === 0 ? (
          <EmptyState title={t("admin.logs_empty_title")} />
        ) : (
          <ListGroup>
            {logs.map((log) => (
              <ListItem
                key={log.Name}
                title={log.Name ?? ""}
                subtitle={formatSize(log.Size)}
                showArrow
                onPress={() => setOpenLog(log.Name ?? null)}
              />
            ))}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}
