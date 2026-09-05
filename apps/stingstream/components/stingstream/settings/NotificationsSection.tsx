import { useState } from "react";
import { TextInput, TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import type { NotificationSettings } from "@/lib/stingstream/hooks";
import { SaveBar, ToggleRow } from "./fields";

export function NotificationsSection({
  value,
  onSave,
  saving,
}: {
  value: NotificationSettings;
  onSave: (next: NotificationSettings) => Promise<void>;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const events: { key: keyof NotificationSettings; label: string }[] = [
    { key: "OnGrab", label: "On grab" },
    { key: "OnDownload", label: "On import" },
    { key: "OnUpgrade", label: "On upgrade" },
    { key: "OnRename", label: "On rename" },
    { key: "OnDelete", label: "On delete" },
  ];

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-2'>
        Notifications
      </Text>
      <ListGroup title="StingStream's own webhook (drives the federated import path)">
        <ToggleRow
          title='Enabled'
          value={draft.WebhookEnabled ?? false}
          onValueChange={(v) => setDraft((d) => ({ ...d, WebhookEnabled: v }))}
        />
        {events.map((e) => (
          <ToggleRow
            key={e.key}
            title={e.label}
            value={(draft[e.key] as boolean) ?? false}
            onValueChange={(v) => setDraft((d) => ({ ...d, [e.key]: v }))}
          />
        ))}
      </ListGroup>

      <View className='h-3' />

      <ListGroup title='Extra webhooks'>
        {(draft.Extra ?? []).map((wh, i) => (
          <ListItem
            key={wh.Id ?? i}
            title={wh.Name || wh.Url || "Webhook"}
            subtitle={wh.Enabled ? "Enabled" : "Disabled"}
            onPress={() =>
              setDraft((d) => ({
                ...d,
                Extra: (d.Extra ?? []).filter((_, idx) => idx !== i),
              }))
            }
          >
            <Text className='text-red-600'>Remove</Text>
          </ListItem>
        ))}
        {(draft.Extra ?? []).length === 0 && (
          <ListItem title='None configured' />
        )}
      </ListGroup>

      <View className='rounded-xl bg-neutral-900 p-3 mt-2'>
        <TextInput
          placeholder='Name'
          placeholderTextColor='#5A5960'
          value={newName}
          onChangeText={setNewName}
          className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
        />
        <TextInput
          placeholder='Webhook URL'
          placeholderTextColor='#5A5960'
          autoCapitalize='none'
          value={newUrl}
          onChangeText={setNewUrl}
          className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
        />
        <TouchableOpacity
          onPress={() => {
            if (!newUrl.trim()) {
              toast.error("A webhook URL is required");
              return;
            }
            setDraft((d) => ({
              ...d,
              Extra: [
                ...(d.Extra ?? []),
                {
                  Id: `${Date.now()}`,
                  Name: newName.trim() || newUrl.trim(),
                  Url: newUrl.trim(),
                  Method: 1,
                  Enabled: true,
                },
              ],
            }));
            setNewName("");
            setNewUrl("");
          }}
          className='rounded-lg py-2 items-center'
          style={{ backgroundColor: Colors.primary }}
        >
          <Text className='text-white font-semibold'>Add webhook</Text>
        </TouchableOpacity>
      </View>

      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(value)}
        onSave={async () => {
          try {
            await onSave(draft);
            toast.success("Notification settings saved");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not save");
          }
        }}
      />
    </View>
  );
}
