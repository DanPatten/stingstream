import {
  getLibraryApi,
  getLibraryStructureApi,
} from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import { apiAtom } from "@/providers/JellyfinProvider";
import { EmptyState, QueryState } from "../shared/ScreenState";

export function LibrariesSection() {
  const api = useAtomValue(apiAtom);

  const {
    data: folders,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["stingstream", "jellyfin-libraries"],
    queryFn: async () => {
      const res = await getLibraryStructureApi(api!).getVirtualFolders();
      return res.data;
    },
    enabled: !!api,
  });

  const scanNow = useMutation({
    mutationFn: async () => {
      await getLibraryApi(api!).refreshLibrary();
    },
    onSuccess: () => toast.success("Library scan started"),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not start scan"),
  });

  return (
    <View>
      <View className='flex-row items-center justify-between mb-2'>
        <Text className='text-white text-lg font-semibold'>Libraries</Text>
        <TouchableOpacity
          disabled={scanNow.isPending}
          onPress={() => scanNow.mutate()}
          className='rounded-lg px-3 py-1.5'
          style={{ backgroundColor: Colors.primary }}
        >
          <Text className='text-white font-semibold'>
            {scanNow.isPending ? "Starting…" : "Scan all now"}
          </Text>
        </TouchableOpacity>
      </View>

      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!folders || folders.length === 0 ? (
          <EmptyState title='No libraries' />
        ) : (
          <ListGroup>
            {folders.map((folder) => (
              <ListItem
                key={folder.ItemId ?? folder.Name}
                title={folder.Name ?? ""}
                subtitle={[folder.CollectionType, ...(folder.Locations ?? [])]
                  .filter(Boolean)
                  .join(" • ")}
              />
            ))}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}
