import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import type { RootFolderSettings } from "@/lib/stingstream/hooks";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { SaveStatus, TextFieldRow } from "./fields";
import { useAutosave } from "./useAutosave";

export function RootFoldersSection({
  value,
  onSave,
  saving,
}: {
  value: RootFolderSettings;
  onSave: (next: RootFolderSettings) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const {
    draft,
    set,
    saving: sending,
  } = useAutosave({
    value,
    save: async (next) => {
      try {
        await onSave(next);
        toast.success(t("server_settings.root_folders_save_success"));
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t("server_settings.save_error"),
        );
      }
    },
  });

  if (!draft) return null;

  return (
    <View>
      <ScreenHeaderRow title={t("server_settings.root_folders_title")} />
      <ListGroup>
        <TextFieldRow
          title={t("server_settings.root_folders_movies_title")}
          subtitle={t("server_settings.root_folders_movies_detail")}
          value={draft.Movies ?? ""}
          onChangeText={(v) => set((d) => ({ ...d, Movies: v }))}
        />
        <TextFieldRow
          title={t("server_settings.root_folders_tv_title")}
          subtitle={t("server_settings.root_folders_tv_detail")}
          value={draft.Tv ?? ""}
          onChangeText={(v) => set((d) => ({ ...d, Tv: v }))}
        />
      </ListGroup>
      <SaveStatus saving={saving || sending} />
    </View>
  );
}
