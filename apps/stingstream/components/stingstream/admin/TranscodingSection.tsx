import type { EncodingOptions } from "@jellyfin/sdk/lib/generated-client/models";
import { getConfigurationApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { apiAtom } from "@/providers/JellyfinProvider";
import { SaveBar, TextFieldRow, ToggleRow } from "../settings/fields";
import { QueryState } from "../shared/ScreenState";

export function TranscodingSection() {
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
      toast.success("Transcoding settings saved");
      queryClient.invalidateQueries({
        queryKey: ["stingstream", "jellyfin-encoding-config"],
      });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(data);

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>Transcoding</Text>
      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {draft && (
          <>
            <ListGroup>
              <TextFieldRow
                title='Hardware acceleration'
                subtitle='none, qsv, nvenc, amf, vaapi, videotoolbox, rkmpp...'
                value={draft.HardwareAccelerationType ?? "none"}
                onChangeText={(v) =>
                  setDraft((d) =>
                    d ? { ...d, HardwareAccelerationType: v as never } : d,
                  )
                }
              />
              <TextFieldRow
                title='Encoding thread count'
                subtitle='-1 uses the default'
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
                title='Transcoding temp path'
                subtitle='Empty uses the default cache path'
                value={draft.TranscodingTempPath ?? ""}
                onChangeText={(v) =>
                  setDraft((d) => (d ? { ...d, TranscodingTempPath: v } : d))
                }
              />
              <ToggleRow
                title='Throttle transcodes once caught up'
                value={draft.EnableThrottling ?? false}
                onValueChange={(v) =>
                  setDraft((d) => (d ? { ...d, EnableThrottling: v } : d))
                }
              />
              <ToggleRow
                title='Delete unwatched HLS segments'
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
