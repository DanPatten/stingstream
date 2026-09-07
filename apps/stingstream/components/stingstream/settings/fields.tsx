import { useTranslation } from "react-i18next";
import { TextInput, View } from "react-native";
import { Button } from "@/components/Button";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { ListItem } from "@/components/list/ListItem";
import { resolveTextStyle, tokens } from "@/constants/theme";
import { useBreakpointName } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";

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
  const breakpoint = useBreakpointName();
  return (
    <ListItem title={title} subtitle={subtitle}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={tokens.color.text.tertiary}
        keyboardType={keyboardType}
        style={[
          resolveTextStyle("body", "primary", "regular", breakpoint),
          { textAlign: "right", minWidth: 120 },
        ]}
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
  const { accent } = useTheme();
  return (
    <ListItem title={title} subtitle={subtitle}>
      <SettingSwitch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: accent[500] }}
      />
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
  const { t } = useTranslation();
  if (!dirty) return null;
  return (
    <View style={{ flexDirection: "row", gap: 12, marginTop: 12 }}>
      <Button variant='secondary' style={{ flex: 1 }} onPress={onDiscard}>
        {t("server_settings.discard_action")}
      </Button>
      <Button
        variant='primary'
        style={{ flex: 1 }}
        loading={saving}
        onPress={onSave}
      >
        {t("server_settings.save_action")}
      </Button>
    </View>
  );
}
