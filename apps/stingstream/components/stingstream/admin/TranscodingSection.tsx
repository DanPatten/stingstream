import type { EncodingOptions } from "@jellyfin/sdk/lib/generated-client/models";
import { getConfigurationApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import { apiAtom } from "@/providers/JellyfinProvider";
import { SaveBar, TextFieldRow, ToggleRow } from "../settings/fields";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { QueryState } from "../shared/ScreenState";

export function TranscodingSection() {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<EncodingOptions | null>(null);

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

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

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

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(data);

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
                  setDraft((d) =>
                    d ? { ...d, HardwareAccelerationType: v as never } : d,
                  )
                }
              />
              <TextFieldRow
                title={t("admin.transcoding_thread_count_title")}
                subtitle={t("admin.transcoding_thread_count_detail")}
                keyboardType='number-pad'
                value={String(draft.EncodingThreadCount ?? -1)}
                onChangeText={(v) =>
                  setDraft((d) =>
                    d
                      ? {
                          ...d,
                          EncodingThreadCount: Number.parseInt(v, 10) || -1,
                        }
                      : d,
                  )
                }
              />
              <TextFieldRow
                title={t("admin.transcoding_temp_path_title")}
                subtitle={t("admin.transcoding_temp_path_detail")}
                value={draft.TranscodingTempPath ?? ""}
                onChangeText={(v) =>
                  setDraft((d) => (d ? { ...d, TranscodingTempPath: v } : d))
                }
              />
              <ToggleRow
                title={t("admin.transcoding_throttle_title")}
                value={draft.EnableThrottling ?? false}
                onValueChange={(v) =>
                  setDraft((d) => (d ? { ...d, EnableThrottling: v } : d))
                }
              />
              <ToggleRow
                title={t("admin.transcoding_delete_segments_title")}
                value={draft.EnableSegmentDeletion ?? false}
                onValueChange={(v) =>
                  setDraft((d) => (d ? { ...d, EnableSegmentDeletion: v } : d))
                }
              />
            </ListGroup>
            <SaveBar
              dirty={dirty}
              saving={save.isPending}
              onDiscard={() => setDraft(data ?? null)}
              onSave={() => draft && save.mutate(draft)}
            />
          </>
        )}
      </QueryState>
    </View>
  );
}
