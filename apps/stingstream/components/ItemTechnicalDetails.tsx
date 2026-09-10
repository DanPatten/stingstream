import type {
  MediaSourceInfo,
  MediaStream,
} from "@jellyfin/sdk/lib/generated-client";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import { formatBitrate } from "@/utils/bitrate";

interface Props {
  source?: MediaSourceInfo;
}

/**
 * The file's technical facts, folded away until asked for.
 *
 * Pass-02 put this block — size, resolution, SDR, codec, bitrate, fps — *above*
 * the overview, so the first thing the pre-play page said about a film was its
 * average bitrate (F-26). Almost nobody wants this, and the few who do want all
 * of it, which is what a disclosure is for: one line at the bottom of the page,
 * everything behind it.
 *
 * Inline rather than the bottom sheet it used to open. A sheet is for a choice;
 * this is a read, and a sheet on a desktop browser is the "phone app in a
 * window" the whole overhaul is trying to undo.
 */
export const ItemTechnicalDetails: React.FC<Props> = ({ source }) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const { gutter } = useBreakpoint();
  const [open, setOpen] = useState(false);
  const states = usePressableStates({});

  const video = useMemo(
    () => source?.MediaStreams?.find((stream) => stream.Type === "Video"),
    [source?.MediaStreams],
  );
  const audio = useMemo(
    () =>
      source?.MediaStreams?.filter((stream) => stream.Type === "Audio") ?? [],
    [source?.MediaStreams],
  );
  const subtitles = useMemo(
    () =>
      source?.MediaStreams?.filter((stream) => stream.Type === "Subtitle") ??
      [],
    [source?.MediaStreams],
  );

  if (!source || !video) return null;

  return (
    <View testID='details-technical' style={{ paddingHorizontal: gutter }}>
      <Pressable
        accessibilityRole='button'
        accessibilityLabel={t("item.details")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((previous) => !previous)}
        {...states.handlers}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            minHeight: tokens.control.minTouchTarget,
            paddingHorizontal: 14,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: color.border.subtle,
            backgroundColor: states.overlay ?? color.bg["1"],
          },
          states.webStyle,
        ]}
      >
        <Text variant='body' weight='semibold'>
          {t("item.details")}
        </Text>
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={18}
          tone='secondary'
        />
      </Pressable>

      {open ? (
        <View style={{ paddingTop: 16, gap: 16 }}>
          <Group title={t("item_card.video")}>
            <Chips
              values={[
                formatFileSize(source.Size),
                video.Width && video.Height
                  ? `${video.Width}×${video.Height}`
                  : null,
                isDolbyVision(video) ? "Dolby Vision" : video.VideoRange,
                video.Codec?.toUpperCase(),
                formatBitrate(video.BitRate),
                video.AverageFrameRate != null
                  ? `${video.AverageFrameRate.toFixed(0)} fps`
                  : null,
              ]}
            />
          </Group>

          {audio.length > 0 ? (
            <Group title={t("item_card.audio")}>
              {audio.map((stream) => (
                <Stream key={stream.Index} title={stream.DisplayTitle}>
                  <Chips
                    values={[
                      stream.Language,
                      stream.Codec?.toUpperCase(),
                      stream.ChannelLayout,
                      formatBitrate(stream.BitRate),
                    ]}
                  />
                </Stream>
              ))}
            </Group>
          ) : null}

          {subtitles.length > 0 ? (
            <Group title={t("item_card.subtitles.label")}>
              {subtitles.map((stream) => (
                <Stream key={stream.Index} title={stream.DisplayTitle}>
                  <Chips
                    values={[stream.Language, stream.Codec?.toUpperCase()]}
                  />
                </Stream>
              ))}
            </Group>
          ) : null}
        </View>
      ) : null}
    </View>
  );
};

const isDolbyVision = (stream: MediaStream): boolean =>
  stream.VideoRangeType === "DOVI" ||
  stream.DvVersionMajor != null ||
  stream.DvVersionMinor != null;

const Group: React.FC<React.PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => (
  <View>
    <Text
      variant='caption'
      tone='tertiary'
      weight='semibold'
      style={{ marginBottom: 8 }}
    >
      {title.toUpperCase()}
    </Text>
    <View style={{ gap: 10 }}>{children}</View>
  </View>
);

const Stream: React.FC<React.PropsWithChildren<{ title?: string | null }>> = ({
  title,
  children,
}) => (
  <View>
    {title ? (
      <Text
        variant='caption'
        tone='secondary'
        numberOfLines={1}
        style={{ marginBottom: 6 }}
      >
        {title}
      </Text>
    ) : null}
    {children}
  </View>
);

const Chips: React.FC<{ values: (string | null | undefined)[] }> = ({
  values,
}) => (
  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
    {values
      .filter((value): value is string => Boolean(value))
      .map((value) => (
        <Pill key={value} label={value} size='sm' />
      ))}
  </View>
);

const UNITS = ["B", "KB", "MB", "GB", "TB"];

const formatFileSize = (bytes?: number | null): string | null => {
  if (!bytes || bytes <= 0) return null;
  const exponent = Math.min(
    UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[exponent]}`;
};
