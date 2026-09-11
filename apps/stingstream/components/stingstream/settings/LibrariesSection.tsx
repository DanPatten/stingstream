import { getLibraryApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  type Library,
  libraryPath,
  useLibraries,
  useSaveLibrary,
} from "@/lib/stingstream/libraries";
import { apiAtom } from "@/providers/JellyfinProvider";
import { QueryState } from "../shared/ScreenState";
import { TextFieldRow } from "./fields";
import { useAutosave } from "./useAutosave";

/**
 * What this server holds, and whether it goes and gets more.
 *
 * This is one section where there were three controls on two pages: a pair of blank "root folder"
 * boxes, a read-only list of libraries underneath them showing the same folders back, and a
 * Downloading page elsewhere carrying the switches that decided whether anything was fetched at
 * all. Dan, on finding the first two: *"I still see root folders and libraries, I dont want both"*,
 * and on the third: *"if you can have a library then you can download too, unified that with the
 * downloading settings"*.
 *
 * So a library is a row: its name, whether this server runs it, and the folder it writes to.
 *
 * **The switch says whether this server keeps that kind of library. It does not start a manager on
 * its own**, though it used to. A manager runs when the library is on *and* an enabled indexer
 * covers the kind, which is the server's rule (`ArrEnablement`) over the saved settings rather than
 * anything this screen decides. Switching a library on therefore starts nothing until there is
 * somewhere to search, which is the honest behaviour: a manager with no indexer can do nothing but
 * look broken.
 *
 * **No status here.** There was a Running / Starting / Failed pill and the child's last error, which
 * turned a settings row into a process monitor for states that are mostly transitional and none of
 * which a reader could act on from this screen. Dan: *"just a simple toggle, all other work goes
 * background +logs"*.
 */
export function LibrariesSection() {
  const { t } = useTranslation();
  const libraries = useLibraries();

  return (
    <View>
      {/*
        No heading. The pane above already says Libraries, and repeating it directly underneath is
        the page saying the same word twice before the first control. The scan button still needs
        somewhere to be, so it sits alone on the row the heading would have been.
      */}
      <View style={{ alignItems: "flex-end", marginBottom: space["3"] }}>
        <ScanButton />
      </View>
      <QueryState
        isLoading={libraries.isLoading}
        error={libraries.error}
        onRetry={libraries.refetch}
      >
        <View style={{ gap: space["4"] }}>
          {(libraries.data ?? []).map((library) => (
            <LibraryRow key={library.id} library={library} />
          ))}
        </View>
      </QueryState>
    </View>
  );
}

/**
 * The only way to ask the media server to look at the folders again.
 *
 * It survives from the read-only list this section replaced, where it was the one control worth
 * keeping: everything else on that list was the same folders a reader had just set, drawn back at
 * them with no way to act on any of it.
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

/**
 * One library: the switch, then its folder while it is on.
 *
 * The folder disappears with the switch rather than greying out, because an off library has no
 * folder in any meaningful sense — nothing is written there and nothing reads it. What takes its
 * place is the one sentence somebody switching a library off actually wants: their files are
 * still there.
 */
function LibraryRow({ library }: { library: Library }) {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const save = useSaveLibrary();

  const { draft, set, saving } = useAutosave({
    value: libraryPath(library),
    save: async (path) => {
      try {
        await save.mutateAsync({ id: library.id, update: { path } });
      } catch (err) {
        // The node validates a folder and says why it refused: a path inside another library, a
        // path it cannot write to, the federated tree itself. That sentence is written for a
        // reader, so it is shown as it arrived rather than translated into a generic failure.
        toast.error(
          err instanceof Error ? err.message : t("libraries.save_error"),
        );
      }
    },
  });

  const setEnabled = async (enabled: boolean) => {
    try {
      await save.mutateAsync({ id: library.id, update: { enabled } });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("libraries.save_error"),
      );
    }
  };

  return (
    // Keyed on the name, not the type: Recordings is a *movies* library, so keying on the type
    // gave two rows the same handle and a test asking for "the movies switch" found two.
    <View testID={`library-${library.name.toLowerCase().replace(/\s+/g, "-")}`}>
      <ListGroup>
        {/*
          A switch, and nothing else. There used to be a Running / Starting / Failed pill here and
          the child's last error underneath it, which made a settings row into a process monitor:
          the states it reported were mostly transitional (a manager's first run migrates its
          database for a minute before it binds a port) and none of them were anything the reader
          could act on from here. Dan: *"Remove the running and status labels too in the library -
          just a simple toggle, all other work goes background +logs"*. What the managers are doing
          goes to the log.
        */}
        <ListItem title={library.name}>
          <SettingSwitch
            value={library.enabled}
            disabled={save.isPending}
            onValueChange={(next) => void setEnabled(next)}
            trackColor={{ true: accent[500] }}
          />
        </ListItem>

        {library.enabled && library.managed && draft !== null ? (
          <TextFieldRow
            title={t("libraries.folder_title")}
            subtitle={t("libraries.folder_detail")}
            value={draft}
            autoCapitalize='none'
            onChangeText={(v) => set(() => v)}
          />
        ) : null}
      </ListGroup>

      {!library.enabled ? (
        <Text
          variant='caption'
          tone='secondary'
          style={{ marginTop: space["2"] }}
        >
          {t("libraries.off_detail")}
        </Text>
      ) : null}
      {saving ? (
        <Text
          variant='caption'
          tone='tertiary'
          style={{ marginTop: space["2"] }}
        >
          {t("libraries.saving")}
        </Text>
      ) : null}
    </View>
  );
}
