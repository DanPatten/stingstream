import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { LibraryActionsMenu } from "@/components/library/LibraryActionsMenu";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { SettingsPane } from "@/components/settings/panes/SettingsPane";
import { space } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import {
  isRecordings,
  isRemovable,
  type Library,
  useDeleteLibrary,
  useLibraries,
  useSaveLibrary,
} from "@/lib/stingstream/libraries";
import { confirmDestructive } from "../shared/confirm";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { FolderBrowserDialog } from "./FolderBrowserDialog";
import { FolderList } from "./FolderList";

/**
 * One library: whether it runs, its folders, and the "..." with everything else.
 *
 * Every change is sent the moment it is made, like the rest of settings. Adding a folder is
 * a pick in the browser and removing one is a press, and a refusal comes back as the server's own
 * sentence.
 */
export function LibraryDetailScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const libraries = useLibraries();
  const library = libraries.data?.find((row) => row.id === id);

  return (
    <QueryState
      isLoading={libraries.isLoading}
      error={libraries.error}
      onRetry={libraries.refetch}
    >
      {library ? (
        <LibraryDetail library={library} />
      ) : (
        <EmptyState title={t("libraries.not_found")} />
      )}
    </QueryState>
  );
}

function LibraryDetail({ library }: { library: Library }) {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const router = useRouter();
  const save = useSaveLibrary();
  const remove = useDeleteLibrary();
  const [browsing, setBrowsing] = useState(false);
  const recordings = isRecordings(library);

  const send = async (
    update: Parameters<typeof save.mutateAsync>[0]["update"],
  ) => {
    try {
      await save.mutateAsync({ id: library.id, update });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("libraries.save_error"),
      );
    }
  };

  const onDelete = async () => {
    const ok = await confirmDestructive(
      t("libraries.delete_title", { name: library.name }),
      t("libraries.delete_detail"),
      t("libraries.delete"),
    );
    if (!ok) return;
    try {
      await remove.mutateAsync(library.id);
      toast.success(t("libraries.deleted"));
      router.replace("/settings/storage");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("libraries.save_error"),
      );
    }
  };

  const addFolder = (path: string) => {
    setBrowsing(false);
    if (recordings) {
      void send({ paths: [path] });
      return;
    }
    if (library.paths.some((p) => p.toLowerCase() === path.toLowerCase()))
      return;
    void send({ paths: [...library.paths, path] });
  };

  return (
    <SettingsPane
      title={library.name}
      accessory={
        <LibraryActionsMenu
          jellyfinId={library.enabled ? library.jellyfinItemId : undefined}
          name={library.name}
          onDelete={isRemovable(library) ? () => void onDelete() : undefined}
        />
      }
    >
      <View testID='library-detail' style={{ gap: space["6"] }}>
        <View>
          <ListGroup>
            <ListItem title={t("libraries.enabled_title")}>
              <SettingSwitch
                value={library.enabled}
                onValueChange={(enabled) => void send({ enabled })}
                trackColor={{ true: accent[500] }}
              />
            </ListItem>
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
        </View>

        {library.enabled ? (
          <View style={{ gap: space["2"] }}>
            <Text variant='caption' tone='secondary' weight='medium'>
              {t("libraries.folders_title")}
            </Text>
            <FolderList
              paths={library.paths}
              disabled={save.isPending}
              // A built-in library with no folder of its own follows the default, so its last
              // folder can go; an added library cannot be left with none, and Recordings always
              // has exactly one.
              onRemove={
                recordings
                  ? undefined
                  : (path) =>
                      void send({
                        paths: library.paths.filter((p) => p !== path),
                      })
              }
              canRemove={() => library.builtin || library.paths.length > 1}
              onAdd={() => setBrowsing(true)}
              addLabel={recordings ? t("libraries.change_folder") : undefined}
            />
          </View>
        ) : null}
      </View>

      <FolderBrowserDialog
        visible={browsing}
        initialPath={library.paths[library.paths.length - 1]}
        onClose={() => setBrowsing(false)}
        onSelect={addFolder}
      />
    </SettingsPane>
  );
}
