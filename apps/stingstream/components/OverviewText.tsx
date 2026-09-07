import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View, type ViewProps } from "react-native";
import { SectionHeader } from "@/components/common/SectionHeader";
import { Text } from "@/components/common/Text";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePressableStates } from "@/hooks/usePressableStates";

interface Props extends ViewProps {
  text?: string | null;
  /** Lines shown before the "More" link. Four is about a Plex synopsis. */
  lines?: number;
  /** Suppress the "Overview" heading — a page whose whole body is the synopsis. */
  showTitle?: boolean;
  /**
   * Indent the text by the page gutter, the way `SectionHeader` and `CardRow`
   * already do. Off by default because most callers are already inside a padded
   * container and would get it twice.
   */
  gutter?: boolean;
}

/**
 * A synopsis that expands.
 *
 * Measured in *lines*, not characters. The old version cut at 100 characters
 * and appended nothing, so a 99-character overview and a 101-character one
 * looked like different components, and the same limit produced two lines on a
 * phone and half a line at 1440. `numberOfLines` lets the platform do the
 * measuring, which is the only way one number works at every width.
 */
export const OverviewText: React.FC<Props> = ({
  text,
  lines = 4,
  showTitle = true,
  gutter = false,
  ...props
}) => {
  const { gutter: pageGutter } = useBreakpoint();
  const [expanded, setExpanded] = useState(false);
  // Only offer "More" when the text is actually clipped: a two-line overview
  // with a "More" link under it is a control that does nothing.
  const [clipped, setClipped] = useState(false);
  const { t } = useTranslation();
  const states = usePressableStates({});

  const onTextLayout = useCallback(
    (event: { nativeEvent: { lines: unknown[] } }) => {
      if (event.nativeEvent.lines.length > lines) setClipped(true);
    },
    [lines],
  );

  if (!text) return null;

  return (
    <View {...props}>
      {showTitle ? <SectionHeader title={t("item_card.overview")} /> : null}
      <View style={gutter ? { paddingHorizontal: pageGutter } : undefined}>
        <Text
          variant='body'
          tone='secondary'
          selectable
          numberOfLines={expanded ? undefined : lines}
          onTextLayout={onTextLayout}
        >
          {text}
        </Text>
        {clipped ? (
          <Pressable
            accessibilityRole='button'
            onPress={() => setExpanded((previous) => !previous)}
            {...states.handlers}
            style={[
              { alignSelf: "flex-start", paddingVertical: 8, paddingRight: 8 },
              states.webStyle,
            ]}
          >
            <Text variant='body' tone='accent' weight='semibold'>
              {expanded ? t("item.less") : t("item.more")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
};
