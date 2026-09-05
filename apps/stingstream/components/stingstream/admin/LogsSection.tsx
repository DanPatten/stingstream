import { getSystemApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { apiAtom } from "@/providers/JellyfinProvider";
import { EmptyState, QueryState } from "../shared/ScreenState";

function formatSize(bytes?: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** exp).toFixed(1)} ${units[exp]}`;
}

export function LogsSection() {
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
        <Text className='text-[#0584FE] mb-2' onPress={() => setOpenLog(null)}>
          {"< Back to logs"}
        </Text>
        <Text className='text-white font-semibold mb-2'>{openLog}</Text>
        <ScrollView
          horizontal
          className='rounded-xl bg-neutral-900 p-3 max-h-[500px]'
        >
          <Text className='text-[#9899A1] text-xs font-mono' selectable>
            {contentLoading ? "Loading…" : (logContent ?? "")}
          </Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>Server logs</Text>
      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!logs || logs.length === 0 ? (
          <EmptyState title='No log files' />
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
