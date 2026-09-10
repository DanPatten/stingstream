/**
 * "Play from — Auto" on the details page, under the Play button.
 *
 * It used to be a 48pt icon button in the row of media options, which put "which of your servers
 * is this coming from?" at the same weight as a subtitle picker and gave no hint of the answer
 * until it was opened. On a library where a title can sit on three machines that is the question
 * the page most needs to answer, so it says the answer out loud: Auto, and what Auto currently
 * resolves to.
 *
 * Renders nothing when there is only one copy. On a single-server library the question does not
 * exist, and a control that can only ever say one thing reads as broken rather than as simple.
 */

import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { type FC, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View, type ViewStyle } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useSourceSelection } from "@/hooks/useSourceSelection";
import { useTheme } from "@/hooks/useTheme";
import { SourceChooserSheet } from "./SourceChooserSheet";

export interface SourceSelectorProps {
  item?: BaseItemDto | null;
  currentMediaSourceId?: string | null;
  /** Adopt the chosen source for the play that follows. */
  onSelect: (mediaSourceId: string) => void;
  style?: ViewStyle;
}

export const SourceSelector: FC<SourceSelectorProps> = ({
  item,
  currentMediaSourceId,
  onSelect,
  style,
}) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const { isCompact } = useBreakpoint();
  const states = usePressableStates({});
  const [open, setOpen] = useState(false);

  const selection = useSourceSelection(item, {
    currentMediaSourceId,
    onSelectMediaSource: onSelect,
  });

  if (!selection.hasChoice) return null;

  // Why the pin is not being honoured, when it is not. Both sentences name the server, because
  // "a server you chose is offline" tells nobody anything they can act on.
  const warning =
    selection.resolved.mode === "pinned-offline"
      ? t("player.source.pinned_offline", {
          name: selection.resolved.pinnedName,
        })
      : selection.resolved.mode === "pinned-missing"
        ? t("player.source.pinned_missing", {
            name: selection.resolved.pinnedName,
          })
        : null;

  // Only under Auto: with a pin the row already names the server, and repeating it as "right now
  // that is …" would read as though something else had been decided.
  const detail =
    !warning && selection.resolved.mode === "auto" && selection.autoTarget
      ? t("player.source.auto_now", { source: selection.autoTarget })
      : null;

  return (
    <>
      <Pressable
        testID='details-play-from'
        onPress={() => setOpen(true)}
        accessibilityRole='button'
        accessibilityLabel={`${t("player.source.play_from")}: ${selection.label}`}
        {...states.handlers}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: radius.md,
            backgroundColor:
              states.state === "rest" ? color.bg["2"] : color.bg["3"],
            minHeight: 48,
            // Full width under a full-width Play button on a phone; an inline pill on a desktop,
            // where the action row is a line of controls rather than a stack.
            alignSelf: isCompact ? "stretch" : "flex-start",
          },
          states.webStyle,
          style ?? null,
        ]}
      >
        <Icon name='sharing' size={18} tone='secondary' />
        <View style={{ flex: isCompact ? 1 : undefined }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text variant='caption' tone='tertiary'>
              {t("player.source.play_from")}
            </Text>
            <Text variant='body' weight='semibold' numberOfLines={1}>
              {selection.label}
            </Text>
          </View>
          {warning ? (
            <Text variant='caption' tone='secondary' numberOfLines={2}>
              {warning}
            </Text>
          ) : detail ? (
            <Text variant='caption' tone='secondary' numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
        </View>
        <Icon name='chevronDown' size={16} tone='tertiary' />
      </Pressable>

      <SourceChooserSheet
        visible={open}
        onClose={() => setOpen(false)}
        item={item}
        currentMediaSourceId={currentMediaSourceId}
        currentLabel={t("player.source.selected")}
        selection={selection}
      />
    </>
  );
};
