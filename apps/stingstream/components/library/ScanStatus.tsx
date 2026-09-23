import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { elevation, radius, space } from "@/constants/theme";
import {
  useRefreshItemsWhileScanning,
  useScanStatus,
} from "@/hooks/useScanStatus";
import { useTheme } from "@/hooks/useTheme";
import {
  libraryScanLabel,
  type ScanSummary,
  scanPillLabel,
} from "@/lib/stingstream/scanStatus";

/**
 * Library scan progress, in the three places it is useful.
 *
 * - `useLibraryScanLabel` for a row in the list of libraries: a short value, "Scanning, 42%".
 * - `ScanStatus` at the top of one library's settings page: the same words over a slim bar.
 * - `ScanIndicator` on the home page and a library's page: a small pill that floats over the
 *   content, and keeps the lists underneath refetching so movies appear as they are found.
 *
 * All three draw nothing when no scan is running, and nothing for a member who is not an
 * administrator, who cannot read scan state.
 */

/** A function from a library's media server id to its row value, or null when it is not scanning. */
export function useLibraryScanLabel(): (
  jellyfinItemId: string | null | undefined,
) => string | null {
  const { t } = useTranslation();
  const summary = useScanStatus();
  return useCallback((id) => libraryScanLabel(summary, id, t), [summary, t]);
}

/** A thin bar, with a short stub when the server has not given a number yet. */
function ScanBar({ percent }: { percent: number | null }) {
  const { color, accent } = useTheme();
  return (
    <View
      style={{
        height: 3,
        borderRadius: radius.pill,
        backgroundColor: color.bg["3"],
        overflow: "hidden",
      }}
    >
      <View
        style={{
          height: 3,
          // An unknown amount is shown as a short stub rather than an empty track, which would
          // read as a scan that has not started.
          width: `${percent == null ? 8 : Math.max(percent, 2)}%`,
          backgroundColor: accent[500],
        }}
      />
    </View>
  );
}

/** One library's scan, as a line and a bar. For `LibraryDetailScreen`. */
export function ScanStatus({
  libraryId,
}: {
  libraryId: string | null | undefined;
}) {
  const { t } = useTranslation();
  const summary = useScanStatus();
  const label = libraryScanLabel(summary, libraryId, t);
  if (!label) return null;
  const percent =
    summary.libraries.find((l) => l.id === libraryId)?.percent ?? null;

  return (
    <View
      testID='library-scan-status'
      accessibilityRole='progressbar'
      accessibilityLabel={label}
      accessibilityValue={
        percent == null ? undefined : { min: 0, max: 100, now: percent }
      }
      style={{ gap: space["2"] }}
    >
      <Text variant='caption' tone='secondary'>
        {label}
      </Text>
      <ScanBar percent={percent} />
    </View>
  );
}

function ScanPill({
  label,
  percent,
}: {
  label: string;
  percent: number | null;
}) {
  const { color } = useTheme();
  return (
    <View
      testID='scan-indicator'
      accessibilityRole='progressbar'
      accessibilityLabel={label}
      accessibilityLiveRegion='polite'
      accessibilityValue={
        percent == null ? undefined : { min: 0, max: 100, now: percent }
      }
      style={{
        minWidth: 200,
        maxWidth: 360,
        gap: space["2"],
        paddingVertical: space["2"],
        paddingHorizontal: space["4"],
        borderRadius: radius.lg,
        backgroundColor: color.bg["1"],
        borderWidth: 1,
        borderColor: color.border.strong,
        ...elevation(2, color),
      }}
    >
      <Text variant='caption' tone='secondary' numberOfLines={1}>
        {label}
      </Text>
      <ScanBar percent={percent} />
    </View>
  );
}

/**
 * "Scanning Movies, 42%", floating at the bottom of the page while a scan runs.
 *
 * Never in the way: it sits over the content rather than pushing it down, ignores the pointer,
 * and goes as soon as the scan does. Rendered inside a container that fills the page, since it
 * is positioned against it. `inline` puts it in the flow instead, for an empty page where there
 * is nothing for it to float over.
 *
 * `libraryId` narrows it to one library's page, where another library's scan is not news.
 */
export function ScanIndicator({
  libraryId,
  inline = false,
}: {
  libraryId?: string | null;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const summary = useScanStatus();
  useRefreshItemsWhileScanning(summary.active);
  const label = scanPillLabel(summary, t, libraryId);
  if (!label) return null;
  const percent = pillPercent(summary, libraryId);

  if (inline) {
    return (
      <View style={{ alignItems: "center", marginTop: space["4"] }}>
        <ScanPill label={label} percent={percent} />
      </View>
    );
  }

  return (
    <View
      pointerEvents='none'
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: space["4"],
        alignItems: "center",
      }}
    >
      <ScanPill label={label} percent={percent} />
    </View>
  );
}

/** The number the pill's bar shows: this library's own on its page, the whole scan's elsewhere. */
function pillPercent(
  summary: ScanSummary,
  libraryId: string | null | undefined,
): number | null {
  if (!libraryId) return summary.percent;
  const library = summary.libraries.find((l) => l.id === libraryId);
  if (library) return library.percent;
  return summary.wholeServer ? summary.percent : null;
}
