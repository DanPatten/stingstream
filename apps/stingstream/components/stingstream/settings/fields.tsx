import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Input } from "@/components/common/Input";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { ListItem } from "@/components/list/ListItem";

import { useBreakpointName } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";

/** How wide the field is on a desktop-width row, where it sits beside its label. */
const FIELD_WIDTH = 260;

/**
 * A settings row whose control is a text field.
 *
 * **The field is `components/common/Input`, the same one the sign-in form and every dialog use.**
 * It used to be a bare `TextInput` with no box at all, which on a settings row is indistinguishable
 * from a value the page is merely reporting — Dan, on the server name: *"click the input should
 * highlight it, its not intuative that thats a text input.. can we make sure all text inputs use
 * the same component and on hover highlights the box"*. `Input` is where the rule, the hover tint
 * and the focused border live, so a row that draws its own field is a row that quietly opts out of
 * all three.
 *
 * There is no Save button under it. See `useAutosave`.
 */
export function TextFieldRow({
  title,
  subtitle,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  editable,
  autoCapitalize,
  onBlur,
  disabledByAdmin = false,
}: {
  title: string;
  subtitle?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "number-pad" | "url";
  editable?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  onBlur?: () => void;
  /** Locked by server policy: says so in place of the subtitle, and cannot be typed in. */
  disabledByAdmin?: boolean;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const breakpoint = useBreakpointName();
  const compact = breakpoint === "compact";
  const detail = disabledByAdmin
    ? t("home.settings.disabled_by_admin")
    : subtitle;

  const field = (
    <Input
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      keyboardType={keyboardType}
      editable={editable !== false && !disabledByAdmin}
      autoCapitalize={autoCapitalize}
      onBlur={onBlur}
      style={compact ? { marginTop: 8 } : { width: FIELD_WIDTH }}
    />
  );

  // On a phone the field goes *under* its label rather than beside it.
  //
  // A `ListItem`'s children sit on the right with no shrink of their own, so a
  // 260 px field beside "Transcoding temporary path" would leave the label
  // ellipsised and the row overflowing at 390 px — confirmed by the screenshot
  // sweep on Transcoding & hardware and Network & remote access, which between
  // them are most of these rows. Neither half of a settings field should have to
  // be guessed at from four surviving characters.
  if (compact) {
    return (
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          backgroundColor: color.bg["1"],
        }}
      >
        <Text numberOfLines={2}>{title}</Text>
        {detail ? (
          <Text
            variant='caption'
            tone={disabledByAdmin ? "danger" : "secondary"}
            style={{ marginTop: 2 }}
            numberOfLines={3}
          >
            {detail}
          </Text>
        ) : null}
        {field}
      </View>
    );
  }

  return (
    <ListItem
      title={title}
      subtitle={subtitle}
      disabledByAdmin={disabledByAdmin}
    >
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

/**
 * What is left of the Save bar: a line that says a change is on its way.
 *
 * Settings apply themselves now (`useAutosave`), so the only thing a reader still needs from that
 * corner of the screen is the gap between "I typed it" and "the server has it" — which on a push
 * into a download client or an indexer is a real second or two, not a flicker. The success and
 * failure messages stay toasts, in the bottom right.
 *
 * It keeps its height while idle so a settings page does not jump every time somebody edits a
 * field.
 */
export function SaveStatus({ saving }: { saving: boolean }) {
  const { t } = useTranslation();
  return (
    <View style={{ minHeight: 24, justifyContent: "center", paddingLeft: 16 }}>
      {saving ? (
        <Text variant='caption' tone='tertiary'>
          {t("server_settings.saving_status")}
        </Text>
      ) : null}
    </View>
  );
}
