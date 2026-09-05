import { useState } from "react";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import type { NamingSettings } from "@/lib/stingstream/hooks";
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
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>Naming</Text>
      <ListGroup>
        <ToggleRow
          title='Rename on import'
          value={draft.RenameOnImport ?? false}
          onValueChange={(v) => setDraft((d) => ({ ...d, RenameOnImport: v }))}
        />
        <ToggleRow
          title='Replace illegal characters'
          value={draft.ReplaceIllegalCharacters ?? false}
          onValueChange={(v) =>
            setDraft((d) => ({ ...d, ReplaceIllegalCharacters: v }))
          }
        />
      </ListGroup>
      <View className='h-3' />
      <ListGroup title='Movies (Radarr)'>
        <TextFieldRow
          title='Movie folder format'
          value={draft.MovieFolderFormat ?? ""}
          onChangeText={(v) =>
            setDraft((d) => ({ ...d, MovieFolderFormat: v }))
          }
        />
        <TextFieldRow
          title='Movie file format'
          value={draft.MovieFormat ?? ""}
          onChangeText={(v) => setDraft((d) => ({ ...d, MovieFormat: v }))}
        />
      </ListGroup>
      <View className='h-3' />
      <ListGroup title='Series (Sonarr)'>
        <TextFieldRow
          title='Series folder format'
          value={draft.SeriesFolderFormat ?? ""}
          onChangeText={(v) =>
            setDraft((d) => ({ ...d, SeriesFolderFormat: v }))
          }
        />
        <TextFieldRow
          title='Season folder format'
          value={draft.SeasonFolderFormat ?? ""}
          onChangeText={(v) =>
            setDraft((d) => ({ ...d, SeasonFolderFormat: v }))
          }
        />
        <TextFieldRow
          title='Episode file format'
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
            toast.success("Naming settings saved");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not save");
          }
        }}
      />
    </View>
  );
}
