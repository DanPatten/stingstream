import { TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { Colors } from "@/constants/Colors";
import { useRunSync, useSyncStatus } from "@/lib/stingstream/hooks";

/** Per-app ("Omniarr") sync status, and a manual re-sync button. */
export function SyncStatusBanner() {
  const { data: statuses } = useSyncStatus();
  const runSync = useRunSync();

  const onSync = async () => {
    try {
      await runSync.mutateAsync();
      toast.success("Synced into Radarr and Sonarr");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    }
  };

  return (
    <View className='rounded-xl bg-neutral-900 p-3 mb-3 flex-row items-center justify-between'>
      <View className='flex-1 pr-3'>
        {(statuses ?? []).map((s) => (
          <Text
            key={s.App}
            className={s.Ok ? "text-[#9899A1] text-xs" : "text-red-500 text-xs"}
          >
            {s.App}: {s.Ok ? "synced" : "sync failed"}
            {s.Message ? ` — ${s.Message}` : ""}
          </Text>
        ))}
        {(!statuses || statuses.length === 0) && (
          <Text className='text-[#9899A1] text-xs'>Not synced yet</Text>
        )}
      </View>
      <TouchableOpacity
        onPress={onSync}
        disabled={runSync.isPending}
        className='rounded-lg px-3 py-2'
        style={{ backgroundColor: Colors.primary }}
      >
        <Text className='text-white font-semibold'>
          {runSync.isPending ? "Syncing…" : "Sync now"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
