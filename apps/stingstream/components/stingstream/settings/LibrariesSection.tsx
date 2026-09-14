import { getLibraryApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import type { IconName } from "@/components/common/Icon";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import {
  isRecordings,
  type Library,
  useLibraries,
} from "@/lib/stingstream/libraries";
import { apiAtom } from "@/providers/JellyfinProvider";
import { QueryState } from "../shared/ScreenState";
import { AddLibraryDialog } from "./AddLibraryDialog";

/**
 * What this server holds: every library in a list, each opening its own page.
 *
 * Dan, 2026-09-13, asking for it to work like Plex: a landing page listing all libraries with a way
 * to drill into each one, and as many as he wants. It used to be one row per library with a switch
 * and a single folder box inline, which had nowhere to put a second folder, a delete, or anything
 * else a library needs. The switch and the folders now live on `LibraryDetailScreen`.
 *
 * **The switch says whether this server keeps that kind of library. It does not start a manager on
 * its own.** A manager runs when the library is on *and* an enabled indexer covers the kind, which
 * is the server's rule (`ArrEnablement`) over the saved settings rather than anything this screen
 * decides.
 */
export function LibrariesSection() {
  const { t } = useTranslation();
  const router = useRouter();
  const libraries = useLibraries();
  const [adding, setAdding] = useState(false);

  // Recordings is added rather than always there, and there is only ever one of it.
  const offerRecordings = !(libraries.data ?? []).some(
    (library) => isRecordings(library) && library.enabled,
  );

  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: space["2"],
          marginBottom: space["3"],
        }}
      >
        <ScanButton />
        <Button
          testID='library-add'
          variant='primary'
          size='sm'
          icon='add'
          onPress={() => setAdding(true)}
        >
          {t("libraries.add")}
        </Button>
      </View>
      <QueryState
        isLoading={libraries.isLoading}
        error={libraries.error}
        onRetry={libraries.refetch}
      >
        <ListGroup>
          {(libraries.data ?? []).map((library) => (
            <ListItem
              key={library.id}
              testID={`library-${library.name.toLowerCase().replace(/\s+/g, "-")}`}
              title={library.name}
              subtitle={folderSummary(library, t)}
              value={library.enabled ? null : t("libraries.off")}
              icon={iconFor(library)}
              showArrow
              onPress={() =>
                router.push(
                  `/settings/storage/${encodeURIComponent(library.id)}`,
                )
              }
            />
          ))}
        </ListGroup>
      </QueryState>

      <AddLibraryDialog
        visible={adding}
        offerRecordings={offerRecordings}
        onClose={() => setAdding(false)}
      />
    </View>
  );
}

const iconFor = (library: Library): IconName =>
  isRecordings(library)
    ? "radioOn"
    : library.type === "tvshows"
      ? "cast"
      : "play";

function folderSummary(
  library: Library,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const [first, ...rest] = library.paths;
  if (!first) return null;
  return rest.length === 0
    ? first
    : t("libraries.more_folders", { path: first, count: rest.length });
}

/**
 * Ask the media server to look at every library's folders again.
 *
 * One library at a time is its page's "..." (Scan library files); this is all of them.
 */
function ScanButton() {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const queryClient = useQueryClient();

  const scan = useMutation({
    mutationFn: async () => {
      if (!api) throw new Error("Not connected");
      await getLibraryApi(api).refreshLibrary();
    },
    onSuccess: () => {
      toast.success(t("libraries.scan_success"));
      queryClient.invalidateQueries({ queryKey: ["stingstream", "libraries"] });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("libraries.scan_error"),
      ),
  });

  return (
    <Button
      variant='secondary'
      size='sm'
      icon='refresh'
      loading={scan.isPending}
      onPress={() => scan.mutate()}
    >
      {t("libraries.scan_action")}
    </Button>
  );
}
