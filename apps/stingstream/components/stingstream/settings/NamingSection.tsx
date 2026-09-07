import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import type { NamingSettings } from "@/lib/stingstream/hooks";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { SaveBar, TextFieldRow, ToggleRow } from "./fields";

export function NamingSection({
  value,
  onSave,
  saving,
}: {
  value: NamingSettings;
  onSave: (next: NamingSettings) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);

  return (
    <View>
      <ScreenHeaderRow title={t("server_settings.naming_title")} />
      <ListGroup>
        <ToggleRow
          title={t("server_settings.naming_rename_on_import_title")}
          value={draft.RenameOnImport ?? false}
          onValueChange={(v) => setDraft((d) => ({ ...d, RenameOnImport: v }))}
        />
        <ToggleRow
          title={t("server_settings.naming_replace_illegal_title")}
          value={draft.ReplaceIllegalCharacters ?? false}
          onValueChange={(v) =>
            setDraft((d) => ({ ...d, ReplaceIllegalCharacters: v }))
          }
        />
      </ListGroup>
      <View style={{ height: 12 }} />
      <ListGroup title={t("server_settings.naming_movies_group_title")}>
        <TextFieldRow
          title={t("server_settings.naming_movie_folder_format_title")}
          value={draft.MovieFolderFormat ?? ""}
          onChangeText={(v) =>
            setDraft((d) => ({ ...d, MovieFolderFormat: v }))
          }
        />
        <TextFieldRow
          title={t("server_settings.naming_movie_file_format_title")}
          value={draft.MovieFormat ?? ""}
          onChangeText={(v) => setDraft((d) => ({ ...d, MovieFormat: v }))}
        />
      </ListGroup>
      <View style={{ height: 12 }} />
      <ListGroup title={t("server_settings.naming_series_group_title")}>
        <TextFieldRow
          title={t("server_settings.naming_series_folder_format_title")}
          value={draft.SeriesFolderFormat ?? ""}
          onChangeText={(v) =>
            setDraft((d) => ({ ...d, SeriesFolderFormat: v }))
          }
        />
        <TextFieldRow
          title={t("server_settings.naming_season_folder_format_title")}
          value={draft.SeasonFolderFormat ?? ""}
          onChangeText={(v) =>
            setDraft((d) => ({ ...d, SeasonFolderFormat: v }))
          }
        />
        <TextFieldRow
          title={t("server_settings.naming_episode_file_format_title")}
          value={draft.EpisodeFormat ?? ""}
          onChangeText={(v) => setDraft((d) => ({ ...d, EpisodeFormat: v }))}
        />
      </ListGroup>
      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(value)}
        onSave={async () => {
          try {
            await onSave(draft);
            toast.success(t("server_settings.naming_save_success"));
          } catch (err) {
            toast.error(
              err instanceof Error
                ? err.message
                : t("server_settings.save_error"),
            );
          }
        }}
      />
    </View>
  );
}
