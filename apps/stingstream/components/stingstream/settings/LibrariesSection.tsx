import { getLibraryApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Pill } from "@/components/common/Pill";
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
  useLibraryHealth,
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
 * So a library is a row: its name, whether this server runs it, and the folder it writes to. The
 * switch is the same switch that starts the manager — one call, `LibrariesController`, writes the
 * settings row and `config.toml` together, because two calls is how the two screens drifted apart
 * in the first place.
 *
 * **The switch is intent; the pill is fact.** The supervisor notices the file within five seconds
 * and a manager starting for the first time migrates its database before it answers, so the two
 * disagree for a minute at a time in the ordinary case and permanently when something is wrong.
 * That is `useLibraryHealth`, and it is the same shape the Downloading page used to draw.
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
  const health = useLibraryHealth(library.enabled ? library : undefined);

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

  const status = (() => {
    if (!library.enabled || health.state === undefined) return null;
    if (health.state === "healthy") {
      return { label: t("libraries.state_running"), tone: "success" as const };
    }
    // On, and not answering yet. A manager's first run migrates its database before it binds a
    // port, which outlasts the supervisor's five-second tick, so this is the ordinary state for a
    // minute after the switch goes on rather than a fault.
    if (health.state === "starting") {
      return { label: t("libraries.state_starting"), tone: "neutral" as const };
    }
    return { label: t("libraries.state_failed"), tone: "danger" as const };
  })();

  return (
    // Keyed on the name, not the type: Recordings is a *movies* library, so keying on the type
    // gave two rows the same handle and a test asking for "the movies switch" found two.
    <View testID={`library-${library.name.toLowerCase().replace(/\s+/g, "-")}`}>
      <ListGroup>
        <ListItem
          title={library.name}
          // `last_error` is what the *last* probe said, and a child that has since answered still
          // carries it until a healthy tick clears it, so it is offered only while the child is
          // not healthy — the only time it explains anything.
          subtitle={
            library.enabled && health.state !== "healthy" && health.error
              ? health.error
              : undefined
          }
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space["2"],
            }}
          >
            {status ? (
              <Pill label={status.label} tone={status.tone} size='sm' />
            ) : null}
            <SettingSwitch
              value={library.enabled}
              disabled={save.isPending}
              onValueChange={(next) => void setEnabled(next)}
              trackColor={{ true: accent[500] }}
            />
          </View>
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
