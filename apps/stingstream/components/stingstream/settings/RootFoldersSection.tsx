import { useState } from "react";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import type { RootFolderSettings } from "@/lib/stingstream/hooks";
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
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>
        Root folders
      </Text>
      <ListGroup>
        <TextFieldRow
          title='Movies'
          subtitle='Empty uses the supervisor default (media/Movies)'
          value={draft.Movies ?? ""}
          onChangeText={(v) => setDraft((d) => ({ ...d, Movies: v }))}
        />
        <TextFieldRow
          title='TV'
          subtitle='Empty uses the supervisor default (media/TV)'
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
            toast.success("Root folders saved");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not save");
          }
        }}
      />
    </View>
  );
}
