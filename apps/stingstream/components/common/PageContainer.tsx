import type { PropsWithChildren } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { maxWidth as MAX_WIDTHS } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";

export type PageWidth = keyof typeof MAX_WIDTHS | number;

export interface PageContainerProps {
  /**
   * `media` (1440) for browse and detail pages, `settings` (960) for forms and
   * lists, `prose` (720) for long text. A number for the rare exception.
   */
  width?: PageWidth;
  /** Skip the left/right gutter — a full-bleed row that scrolls past the edge. */
  bleed?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The measure of a page.
 *
 * react-native-web reproduces a portrait phone layout faithfully at any window
 * size, which is exactly the "clunky and small" complaint: at 2560 px a settings
 * list ran the whole width of the monitor. Every screen's content sits inside
 * one of these, centred, with the gutter its breakpoint calls for.
 *
 * A media page is allowed to be wider than a settings page because rows of
 * posters gain from the room and a column of switches does not — past about
 * 960 px a form is harder to read, not easier.
 */
export const PageContainer: React.FC<PropsWithChildren<PageContainerProps>> = ({
  width = "media",
  bleed = false,
  style,
  children,
}) => {
  const { gutter } = useBreakpoint();

  return (
    <View
      style={[
        {
          width: "100%",
          maxWidth: typeof width === "number" ? width : MAX_WIDTHS[width],
          alignSelf: "center",
          paddingHorizontal: bleed ? 0 : gutter,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
};
