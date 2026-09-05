import { useState } from "react";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { GapNotice } from "../shared/GapNotice";
import { SaveBar, TextFieldRow } from "./fields";

export function QualityProfilesSection({
  value,
  onSave,
  saving,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = draft !== value;

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>
        Quality profiles
      </Text>
      <ListGroup>
        <TextFieldRow
          title='Default profile name'
          subtitle='Used when adding a title without picking one. Empty means "whatever the app lists first".'
          value={draft}
          onChangeText={setDraft}
        />
      </ListGroup>
      <View className='h-3' />
      <GapNotice
        title="Listing and editing profiles isn't available yet"
        detail="Core only stores a profile *name* to default to — it doesn't proxy Radarr's/Sonarr's quality-profile CRUD (creating a profile, editing its cutoff/qualities/groups). See docs/UI-API-GAPS.md. Type an existing profile's exact name above for now."
      />
      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(value)}
        onSave={async () => {
          try {
            await onSave(draft);
            toast.success("Default quality profile saved");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not save");
          }
        }}
      />
    </View>
  );
}
