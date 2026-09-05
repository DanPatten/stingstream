import { TextInput, View } from "react-native";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { ListItem } from "@/components/list/ListItem";

export function TextFieldRow({
  title,
  subtitle,
  value,
  onChangeText,
  placeholder,
  keyboardType,
}: {
  title: string;
  subtitle?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "number-pad";
}) {
  return (
    <ListItem title={title} subtitle={subtitle}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor='#5A5960'
        keyboardType={keyboardType}
        className='text-white text-right min-w-[120px]'
      />
    </ListItem>
  );
}

export function ToggleRow({
  title,
  subtitle,
  value,
  onValueChange,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <ListItem title={title} subtitle={subtitle}>
      <SettingSwitch value={value} onValueChange={onValueChange} />
    </ListItem>
  );
}

export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!dirty) return null;
  return (
    <View className='flex-row gap-3 mt-3'>
      <View className='flex-1 rounded-lg py-2 items-center bg-neutral-800'>
        <Text className='text-white' onPress={onDiscard}>
          Discard
        </Text>
      </View>
      <View className='flex-1 rounded-lg py-2 items-center bg-[#9334E9]'>
        <Text
          className='text-white font-semibold'
          onPress={saving ? undefined : onSave}
        >
          {saving ? "Saving…" : "Save changes"}
        </Text>
      </View>
    </View>
  );
}
