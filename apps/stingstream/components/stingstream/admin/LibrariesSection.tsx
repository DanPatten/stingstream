import {
  getLibraryApi,
  getLibraryStructureApi,
} from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { apiAtom } from "@/providers/JellyfinProvider";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";

export function LibrariesSection() {
  const { t } = useTranslation();
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
    onSuccess: () => toast.success(t("admin.libraries_scan_success")),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("admin.libraries_scan_error"),
      ),
  });

  return (
    <View>
      <ScreenHeaderRow
        title={t("admin.libraries_title")}
        accessory={
          <Button
            variant='secondary'
            size='sm'
            icon='refresh'
            loading={scanNow.isPending}
            onPress={() => scanNow.mutate()}
          >
            {t("admin.libraries_scan_action")}
          </Button>
        }
      />

      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!folders || folders.length === 0 ? (
          <EmptyState title={t("admin.libraries_empty_title")} />
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
