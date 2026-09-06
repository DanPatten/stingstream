/**
 * "Play from…" on phone and web.
 *
 * The mesh has had a complete source-selection data layer since M4 and no screen: the only way to
 * influence which node a federated title streams from was to change the node's own policy. This is
 * that screen — every holder, what each one would give you, and one tap to move.
 *
 * Presented through `Dialog` (WP0) rather than `PlatformDropdown`, which the other pickers use:
 * `PlatformDropdown`'s option shape is a label and a radio dot, and a row here has to carry a
 * subtitle and up to three badges, plus a header control above the list. `Dialog` also gets the
 * surface right on its own — a centred card on a desktop browser, the same bottom sheet as
 * everything else on a phone.
 */

import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { type FC, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { Dialog } from "@/components/common/Dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Pill } from "@/components/common/Pill";
import { Tabs } from "@/components/common/Tabs";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import { useSourceChoices } from "@/hooks/useItemSources";
import { useTheme } from "@/hooks/useTheme";
import {
  formatSourceChoice,
  type PlaybackPolicy,
  type SourceChoice,
  type SourceChoiceLabels,
} from "@/lib/stingstream/sourceChooser";
import { useSettings } from "@/utils/atoms/settings";

export interface SourceChooserSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The item whose holders are listed. Must carry `MediaSources`. */
  item?: BaseItemDto | null;
  currentMediaSourceId?: string | null;
  /**
   * Rows the caller has already built. The in-player chooser passes these because the player needs
   * the same list to decide whether the pill is even a button; leaving it out makes the sheet fetch
   * its own, which is what the pre-play button wants.
   */
  choices?: readonly SourceChoice[];
  /** Called with the chosen `MediaSourceInfo.Id`. Never called for the row already playing. */
  onSelect: (mediaSourceId: string) => void;
}

/** The chooser's own copy of the route colours, so a row's dot matches the player's pill. */
const dotFor = (choice: SourceChoice): string => {
  if (choice.local) return tokens.color.text.primary;
  if (!choice.online) return tokens.color.text.disabled;
  if (choice.route === "direct") return tokens.color.state.success;
  if (choice.route === "relayed") return tokens.color.state.warning;
  return tokens.color.text.tertiary;
};

export const SourceChooserSheet: FC<SourceChooserSheetProps> = ({
  visible,
  onClose,
  item,
  currentMediaSourceId,
  choices: providedChoices,
  onSelect,
}) => {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettings();
  const [pressed, setPressed] = useState<string | null>(null);

  const fetched = useSourceChoices(item, {
    currentMediaSourceId,
    enabled: visible && !providedChoices,
  });
  const choices = providedChoices ?? fetched.choices;
  const isLoading = !providedChoices && fetched.isLoading;

  const labels: SourceChoiceLabels = useMemo(
    () => ({
      direct: t("player.source.direct"),
      relayed: t("player.source.relayed"),
      connecting: t("player.source.connecting"),
      offline: t("player.source.offline"),
      recommended: t("player.source.recommended"),
      sameFile: t("player.source.same_file"),
      playing: t("player.source.playing"),
    }),
    [t],
  );

  const segments = useMemo(
    () => [
      { key: "speed_first", label: t("home.settings.playback_policy.speed") },
      {
        key: "quality_first",
        label: t("home.settings.playback_policy.quality"),
      },
    ],
    [t],
  );

  const handleSelect = useCallback(
    (choice: SourceChoice) => {
      if (choice.disabled || choice.current) return;
      onClose();
      onSelect(choice.mediaSourceId);
    },
    [onClose, onSelect],
  );

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("player.source.play_from")}
      description={t("player.source.play_from_description")}
    >
      <View testID='player-source-chooser'>
        {/* The tab is the setting, not a filter on the list: flipping it changes what this device
            asks the node for and what every future "Play" honours. */}
        <Tabs
          segments={segments}
          value={settings.playbackPolicy}
          onChange={(key) =>
            updateSettings({ playbackPolicy: key as PlaybackPolicy })
          }
          contentInset={0}
          style={{ marginBottom: 12 }}
        />

        {isLoading && choices.length === 0 ? (
          <View style={{ paddingVertical: 32, alignItems: "center" }}>
            <ActivityIndicator />
          </View>
        ) : choices.length === 0 ? (
          <EmptyState
            icon='sharing'
            title={t("player.source.none_title")}
            detail={t("player.source.none_description")}
          />
        ) : (
          choices.map((choice) => (
            <SourceRow
              key={choice.mediaSourceId}
              choice={choice}
              labels={labels}
              pressed={pressed === choice.mediaSourceId}
              onPressIn={() => setPressed(choice.mediaSourceId)}
              onPressOut={() => setPressed(null)}
              onPress={() => handleSelect(choice)}
            />
          ))
        )}
      </View>
    </Dialog>
  );
};

const SourceRow: FC<{
  choice: SourceChoice;
  labels: SourceChoiceLabels;
  pressed: boolean;
  onPress: () => void;
  onPressIn: () => void;
  onPressOut: () => void;
}> = ({ choice, labels, pressed, onPress, onPressIn, onPressOut }) => {
  const { accent } = useTheme();
  const { title, subtitle, badges } = formatSourceChoice(choice, labels);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={choice.disabled}
      accessibilityRole='button'
      accessibilityState={{
        disabled: choice.disabled,
        selected: choice.current,
      }}
      accessibilityLabel={[title, subtitle, ...badges]
        .filter(Boolean)
        .join(", ")}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: 12,
          borderRadius: radius.md,
          marginBottom: 6,
          backgroundColor: pressed
            ? tokens.color.bg["3"]
            : tokens.color.bg["2"],
          borderWidth: 1,
          borderColor: choice.current ? accent[500] : "transparent",
          opacity: choice.disabled ? 0.5 : 1,
        },
        Platform.OS === "web" && !choice.disabled
          ? ({ cursor: "pointer" } as never)
          : null,
      ]}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: radius.pill,
          backgroundColor: dotFor(choice),
          marginRight: 12,
        }}
      />
      <View style={{ flex: 1 }}>
        <Text variant='body' weight='semibold' numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant='caption' tone='secondary' numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {badges.length ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              marginTop: 6,
            }}
          >
            {badges.map((badge) => (
              <Pill
                key={badge}
                label={badge}
                size='sm'
                tone={
                  badge === labels.recommended
                    ? "accent"
                    : badge === labels.offline
                      ? "danger"
                      : "neutral"
                }
                style={{ marginRight: 6 }}
              />
            ))}
          </View>
        ) : null}
      </View>
      {choice.current ? (
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: radius.pill,
            backgroundColor: accent[500],
            marginLeft: 8,
          }}
        />
      ) : null}
    </Pressable>
  );
};
