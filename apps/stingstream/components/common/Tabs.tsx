import { useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import { motion, radius, rgba, tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { Text } from "./Text";
import {
  resolveSegment,
  type Segment,
  shouldChangeSegment,
  type TabsLayout,
  tabsLayoutFor,
} from "./tabSegments";

export type { Segment, TabsLayout };

export interface TabsProps {
  segments: readonly Segment[];
  value: string;
  onChange: (key: string) => void;
  /** Override the width-derived layout — a narrow column on a wide page. */
  layout?: TabsLayout;
  style?: StyleProp<ViewStyle>;
  /** Left/right padding. Defaults to the page gutter for this width. */
  contentInset?: number;
}

/**
 * Switching between the sections of one screen.
 *
 * Underline tabs from `medium` up, scrolling pill segments on a phone — see
 * `tabSegments.ts` for why, and for the selection rules, which are pure and tested.
 * These are flat, same-depth sections of a single screen, deliberately local
 * state rather than a nested navigator: they are not independently
 * deep-linkable, and a router stack here would put a back entry between two
 * halves of the same page.
 */
export const Tabs: React.FC<TabsProps> = ({
  segments,
  value,
  onChange,
  layout,
  style,
  contentInset,
}) => {
  const { accent } = useTheme();
  const { name, gutter } = useBreakpoint();
  const [hovered, setHovered] = useState<string | null>(null);
  const resolved = resolveSegment(segments, value);
  const mode = layout ?? tabsLayoutFor(name);
  const inset = contentInset ?? gutter;

  const press = (key: string) => {
    if (shouldChangeSegment(segments, value, key)) onChange(key);
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: inset,
        flexDirection: "row",
        alignItems: "flex-end",
      }}
      style={[{ flexGrow: 0, flexShrink: 0 }, style]}
    >
      {segments.map((segment) => {
        const active = segment.key === resolved;
        const isHovered = hovered === segment.key && !segment.disabled;

        return (
          <Pressable
            key={segment.key}
            onPress={() => press(segment.key)}
            onHoverIn={() => setHovered(segment.key)}
            onHoverOut={() => setHovered(null)}
            disabled={segment.disabled}
            accessibilityRole='tab'
            accessibilityState={{
              selected: active,
              disabled: segment.disabled,
            }}
            style={[
              mode === "pills"
                ? {
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    marginRight: 8,
                    borderRadius: radius.pill,
                    backgroundColor: active
                      ? accent[500]
                      : isHovered
                        ? tokens.color.bg["3"]
                        : tokens.color.bg["2"],
                  }
                : {
                    paddingHorizontal: 2,
                    paddingBottom: 10,
                    marginRight: 24,
                    borderBottomWidth: 2,
                    // A transparent rule on every tab, not just the active one:
                    // otherwise the row shifts by two pixels as selection moves.
                    borderBottomColor: active
                      ? accent[500]
                      : isHovered
                        ? rgba("#FFFFFF", 0.2)
                        : "transparent",
                  },
              {
                flexDirection: "row",
                alignItems: "center",
                opacity: segment.disabled ? 0.4 : 1,
                ...(Platform.OS === "web"
                  ? {
                      cursor: segment.disabled ? "default" : "pointer",
                      transitionDuration: `${motion.fast}ms`,
                    }
                  : null),
              } as ViewStyle,
            ]}
          >
            <Text
              variant='body'
              weight={active ? "semibold" : "medium"}
              tone={
                mode === "pills" && active
                  ? "onAccent"
                  : active
                    ? "primary"
                    : "secondary"
              }
              numberOfLines={1}
            >
              {segment.label}
            </Text>
            {segment.badge !== undefined && segment.badge !== "" ? (
              <View
                style={{
                  marginLeft: 6,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: radius.pill,
                  backgroundColor:
                    mode === "pills" && active
                      ? rgba("#000000", 0.2)
                      : tokens.color.bg["3"],
                }}
              >
                <Text
                  variant='micro'
                  weight='semibold'
                  tone={mode === "pills" && active ? "onAccent" : "secondary"}
                >
                  {String(segment.badge)}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
};

/** The strip Manage, Server settings and Admin put their `Tabs` in. */
export const TabsBar: React.FC<TabsProps> = (props) => {
  const { name } = useBreakpoint();
  const mode = props.layout ?? tabsLayoutFor(name);

  return (
    <View
      style={{
        paddingTop: 12,
        // Underline tabs carry their own bottom padding, so that the rule lands
        // on the strip's edge rather than floating above it.
        paddingBottom: mode === "pills" ? 12 : 0,
        backgroundColor: tokens.color.bg["0"],
        borderBottomWidth: 1,
        borderBottomColor: tokens.color.border.subtle,
      }}
    >
      <Tabs {...props} />
    </View>
  );
};
