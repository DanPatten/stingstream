import type { EncodingOptions } from "@jellyfin/sdk/lib/generated-client/models";
import { getConfigurationApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import { apiAtom } from "@/providers/JellyfinProvider";
import { SaveStatus, TextFieldRow, ToggleRow } from "../settings/fields";
import { useAutosave } from "../settings/useAutosave";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { QueryState } from "../shared/ScreenState";

export function TranscodingSection() {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["stingstream", "jellyfin-encoding-config"],
    queryFn: async () => {
      const res = await getConfigurationApi(api!).getNamedConfiguration({
        key: "encoding",
      });
      return res.data as EncodingOptions;
    },
    enabled: !!api,
  });

  const save = useMutation({
    mutationFn: async (next: EncodingOptions) => {
      await getConfigurationApi(api!).updateNamedConfiguration({
        key: "encoding",
        body: next,
      });
    },
    onSuccess: () => {
      toast.success(t("admin.transcoding_save_success"));
      queryClient.invalidateQueries({
        queryKey: ["stingstream", "jellyfin-encoding-config"],
      });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("admin.transcoding_save_error"),
      ),
  });

  const { draft, set, saving } = useAutosave<EncodingOptions>({
    value: data,
    save: (next) => save.mutateAsync(next),
  });

  return (
    <View>
      <ScreenHeaderRow title={t("admin.transcoding_title")} />
      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {draft && (
          <>
            <ListGroup>
              <TextFieldRow
                title={t("admin.transcoding_hwaccel_title")}
                subtitle={t("admin.transcoding_hwaccel_detail")}
                value={draft.HardwareAccelerationType ?? "none"}
                onChangeText={(v) =>
                  set((d) => ({ ...d, HardwareAccelerationType: v as never }))
                }
              />
              <TextFieldRow
                title={t("admin.transcoding_thread_count_title")}
                subtitle={t("admin.transcoding_thread_count_detail")}
                keyboardType='number-pad'
                value={String(draft.EncodingThreadCount ?? -1)}
                onChangeText={(v) =>
                  set((d) => ({
                    ...d,
                    EncodingThreadCount: Number.parseInt(v, 10) || -1,
                  }))
                }
              />
              <TextFieldRow
                title={t("admin.transcoding_temp_path_title")}
                subtitle={t("admin.transcoding_temp_path_detail")}
                value={draft.TranscodingTempPath ?? ""}
                onChangeText={(v) =>
                  set((d) => ({ ...d, TranscodingTempPath: v }))
                }
              />
              <ToggleRow
                title={t("admin.transcoding_throttle_title")}
                value={draft.EnableThrottling ?? false}
                onValueChange={(v) =>
                  set((d) => ({ ...d, EnableThrottling: v }), { now: true })
                }
              />
              <ToggleRow
                title={t("admin.transcoding_delete_segments_title")}
                value={draft.EnableSegmentDeletion ?? false}
                onValueChange={(v) =>
                  set((d) => ({ ...d, EnableSegmentDeletion: v }), {
                    now: true,
                  })
                }
              />
            </ListGroup>
            <SaveStatus saving={saving} />
          </>
        )}
      </QueryState>
    </View>
  );
}
