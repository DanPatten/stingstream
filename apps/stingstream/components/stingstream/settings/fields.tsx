import { useTranslation } from "react-i18next";
import { TextInput, View } from "react-native";
import { Button } from "@/components/Button";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
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
  const compact = breakpoint === "compact";

  const field = (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={tokens.color.text.tertiary}
      keyboardType={keyboardType}
      style={[
        resolveTextStyle("body", "primary", "regular", breakpoint),
        compact
          ? { textAlign: "left", marginTop: 6 }
          : { textAlign: "right", minWidth: 120 },
      ]}
    />
  );

  // On a phone the field goes *under* its label rather than beside it.
  //
  // A `ListItem`'s children sit on the right with no shrink of their own, so a
  // 120 px field beside "Transcoding temporary path" left the label ellipsised
  // and the row overflowing at 390 px — confirmed by the screenshot sweep on
  // Transcoding & hardware and Network & remote access, which between them are
  // most of these rows. Neither half of a settings field should have to be
  // guessed at from four surviving characters.
  if (compact) {
    return (
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          backgroundColor: tokens.color.bg["1"],
        }}
      >
        <Text numberOfLines={2}>{title}</Text>
        {subtitle ? (
          <Text
            variant='caption'
            tone='secondary'
            style={{ marginTop: 2 }}
            numberOfLines={3}
          >
            {subtitle}
          </Text>
        ) : null}
        {field}
      </View>
    );
  }

  return (
    <ListItem title={title} subtitle={subtitle}>
      {field}
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
