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
 * A row is the library's name, its type's icon, and Off when it is switched off. Its folders are
 * on its own page and not here. Dan, 2026-09-22: "Don't display the path to each library on this
 * page. Leave that for inside a library."
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
              value={library.enabled ? null : t("libraries.off")}
              icon={iconFor(library)}
              showArrow
              onPress={() =>
                router.push(
                  `/settings/libraries/${encodeURIComponent(library.id)}`,
                )
              }
            />
          ))}
        </ListGroup>
      </QueryState>

      <AddLibraryDialog visible={adding} onClose={() => setAdding(false)} />
    </View>
  );
}

/** The same glyph Add library shows for the type. Recordings, added before it left that list, keeps its own. */
const iconFor = (library: Library): IconName =>
  isRecordings(library)
    ? "radioOn"
    : library.type === "tvshows"
      ? "tvShows"
      : library.type === "homevideos"
        ? "otherVideos"
        : "movies";

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
