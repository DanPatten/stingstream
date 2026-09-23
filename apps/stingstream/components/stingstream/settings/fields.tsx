import { useTranslation } from "react-i18next";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { EmptyState } from "@/components/common/EmptyState";
import type { IconName } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { ListItem } from "@/components/list/ListItem";

import { radius } from "@/constants/theme";
import { useBreakpointName } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { commitAutosaves } from "./autosaver";

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
  fullWidth = false,
  wide = false,
  style,
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
  /** `ListGroup` clones this onto each child to draw the hairline between rows. A row that does
   * not accept and forward it silently loses its rule, which is what every text field row in the
   * app was doing. */
  style?: StyleProp<ViewStyle>;
  /** Locked by server policy: says so in place of the subtitle, and cannot be typed in. */
  disabledByAdmin?: boolean;
  /** Field under the label, spanning the row, at every width. For long values such as a folder
   * path, which a 260 px box beside the label cuts to its first few directories. */
  fullWidth?: boolean;
  /** The box beside the label runs to the end of the row, for a value like an address that the
   * usual width cuts off. The label keeps its own width; the field takes the rest. */
  wide?: boolean;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const breakpoint = useBreakpointName();
  const compact = fullWidth || breakpoint === "compact";
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
      // Leaving the field, or pressing Enter, is what commits it. See `useAutosave`.
      onBlur={() => {
        onBlur?.();
        commitAutosaves();
      }}
      onSubmitEditing={commitAutosaves}
      style={
        compact
          ? { marginTop: 8 }
          : wide
            ? { width: "100%" }
            : { width: FIELD_WIDTH }
      }
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
        style={[
          {
            paddingHorizontal: 16,
            paddingVertical: 10,
            backgroundColor: color.bg["1"],
          },
          style,
        ]}
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
      fillChildren={wide}
      style={style}
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
 * The empty state for one card on a settings page that holds several.
 *
 * `EmptyState` is sized for a whole screen: 64 px above and below, and an action button of its own.
 * Two of those stacked on Indexers & Downloads read as two unrelated pages, one with an icon and a
 * button and one without, each floating in its own sea of padding. A card's empty state sits inside
 * a card the way its list would, always carries an icon, and has no button, because the card's
 * header already has the Add button and a second one said the same thing twice.
 */
export function SectionEmptyState({
  title,
  detail,
  icon,
}: {
  title: string;
  detail: string;
  icon: IconName;
}) {
  const { color } = useTheme();
  return (
    <EmptyState
      title={title}
      detail={detail}
      icon={icon}
      style={{
        paddingVertical: 32,
        borderRadius: radius.lg,
        backgroundColor: color.bg["1"],
      }}
    />
  );
}

/**
 * A labelled switch inside an add or edit form, where a `ToggleRow` would draw a whole list row.
 *
 * Unlike `ToggleRow` it saves nothing by itself: the form it sits in is the one place a click on
 * the form's own button is the decision.
 */
export function FormSwitch({
  title,
  value,
  onValueChange,
}: {
  title: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const { accent } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 8,
      }}
    >
      <Text>{title}</Text>
      <SettingSwitch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: accent[500] }}
      />
    </View>
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
