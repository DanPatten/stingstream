import type { ServerConfiguration } from "@jellyfin/sdk/lib/generated-client/models";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import {
  SaveBar,
  TextFieldRow,
} from "@/components/stingstream/settings/fields";
import { QueryState } from "@/components/stingstream/shared/ScreenState";
import {
  useServerConfiguration,
  useUpdateServerConfiguration,
} from "@/lib/stingstream/jellyfinConfig";

/**
 * When a library notices a file changed, and how hard it works when it scans.
 *
 * These two are the whole of what Jellyfin exposes about scanning, and it is
 * worth saying what is *not* here: there is no per-library scan schedule and no
 * disk-space limit anywhere in the server's API. Rather than draw a control
 * that cannot be wired to anything, the page offers the two that are real. If
 * either lands server-side later, it belongs in this block.
 */
export const LibraryScanningSection: React.FC = () => {
  const { t } = useTranslation();
  const query = useServerConfiguration();
  const update = useUpdateServerConfiguration();
  const [draft, setDraft] = useState<ServerConfiguration | null>(null);

  useEffect(() => {
    if (query.data && !draft) setDraft(query.data);
  }, [query.data, draft]);

  const dirty =
    !!draft && JSON.stringify(draft) !== JSON.stringify(query.data ?? null);

  const save = async () => {
    if (!draft) return;
    try {
      // The whole document: `updateConfiguration` replaces rather than patches.
      await update.mutateAsync(draft);
      toast.success(t("home.settings.storage.saved"));
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t("home.settings.storage.save_failed"),
      );
    }
  };

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      onRetry={query.refetch}
    >
      {draft ? (
        <View>
          <ListGroup title={t("home.settings.storage.scanning_title")}>
            <TextFieldRow
              title={t("home.settings.storage.monitor_delay_title")}
              subtitle={t("home.settings.storage.monitor_delay_detail")}
              keyboardType='number-pad'
              value={String(draft.LibraryMonitorDelay ?? 60)}
              onChangeText={(v) =>
                setDraft((d) =>
                  d
                    ? { ...d, LibraryMonitorDelay: Number.parseInt(v, 10) || 0 }
                    : d,
                )
              }
            />
            <TextFieldRow
              title={t("home.settings.storage.scan_concurrency_title")}
              subtitle={t("home.settings.storage.scan_concurrency_detail")}
              keyboardType='number-pad'
              value={String(draft.LibraryScanFanoutConcurrency ?? 0)}
              onChangeText={(v) =>
                setDraft((d) =>
                  d
                    ? {
                        ...d,
                        LibraryScanFanoutConcurrency:
                          Number.parseInt(v, 10) || 0,
                      }
                    : d,
                )
              }
            />
          </ListGroup>
          <SaveBar
            dirty={dirty}
            saving={update.isPending}
            onDiscard={() => setDraft(query.data ?? null)}
            onSave={save}
          />
        </View>
      ) : null}
    </QueryState>
  );
};
