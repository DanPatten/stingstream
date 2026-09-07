import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { ListGroup } from "@/components/list/ListGroup";
import type { RootFolderSettings } from "@/lib/stingstream/hooks";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { SaveBar, TextFieldRow } from "./fields";

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
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);

  return (
    <View>
      <ScreenHeaderRow title={t("server_settings.root_folders_title")} />
      <ListGroup>
        <TextFieldRow
          title={t("server_settings.root_folders_movies_title")}
          subtitle={t("server_settings.root_folders_movies_detail")}
          value={draft.Movies ?? ""}
          onChangeText={(v) => setDraft((d) => ({ ...d, Movies: v }))}
        />
        <TextFieldRow
          title={t("server_settings.root_folders_tv_title")}
          subtitle={t("server_settings.root_folders_tv_detail")}
          value={draft.Tv ?? ""}
          onChangeText={(v) => setDraft((d) => ({ ...d, Tv: v }))}
        />
      </ListGroup>
      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(value)}
        onSave={async () => {
          try {
            await onSave(draft);
            toast.success(t("server_settings.root_folders_save_success"));
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
