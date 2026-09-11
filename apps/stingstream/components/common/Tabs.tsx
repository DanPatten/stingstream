import {
  Pressable,
  ScrollView,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import { radius, rgba } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePressableStates } from "@/hooks/usePressableStates";
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
  const { name, gutter } = useBreakpoint();
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
      {segments.map((segment) => (
        <TabSegment
          key={segment.key}
          segment={segment}
          active={segment.key === resolved}
          mode={mode}
          onPress={() => press(segment.key)}
        />
      ))}
    </ScrollView>
  );
};

/**
 * One tab.
 *
 * Its own component because hover, press and the keyboard focus ring all come
 * out of `usePressableStates`, and a hook cannot be called inside the map. The
 * strip used to keep one `hovered` key in the parent and draw no ring of its
 * own at all, which left the browser's default `outline: auto 3px` on a row
 * that is a horizontal `ScrollView` — `overflow-y: hidden` on web, so the ring
 * was sheared flat along the top of every tab bar in the app.
 */
const TabSegment: React.FC<{
  segment: Segment;
  active: boolean;
  mode: TabsLayout;
  onPress: () => void;
}> = ({ segment, active, mode, onPress }) => {
  const { color, accent } = useTheme();
  const pills = mode === "pills";
  /** Pills fill with the accent when selected; underline tabs never fill. */
  const onFill = pills && active;
  const states = usePressableStates({
    disabled: segment.disabled,
    // The ring is drawn inside the control, so on a filled pill it takes the
    // label's colour rather than disappearing into the accent behind it.
    ringColor: onFill ? accent.onAccent : undefined,
  });

  return (
    <Pressable
      onPress={onPress}
      {...states.handlers}
      disabled={segment.disabled}
      accessibilityRole='tab'
      accessibilityState={{
        selected: active,
        disabled: segment.disabled,
      }}
      style={[
        pills
          ? {
              paddingHorizontal: 14,
              paddingVertical: 8,
              marginRight: 8,
              borderRadius: radius.pill,
              backgroundColor: active
                ? accent[500]
                : states.hovered
                  ? color.bg["3"]
                  : color.bg["2"],
            }
          : {
              // Room for the focus ring, which is drawn inside the control and
              // would otherwise land on the words: four pixels out on each
              // side, and the same four taken straight back off the margins,
              // so the strip is the height it always was and the labels sit
              // the same distance apart.
              paddingHorizontal: 6,
              paddingTop: 4,
              marginTop: -4,
              paddingBottom: 10,
              marginRight: 20,
              borderBottomWidth: 2,
              // A transparent rule on every tab, not just the active one:
              // otherwise the row shifts by two pixels as selection moves.
              borderBottomColor: active
                ? accent[500]
                : states.hovered
                  ? rgba("#FFFFFF", 0.2)
                  : "transparent",
            },
        {
          flexDirection: "row",
          alignItems: "center",
          opacity: segment.disabled ? 0.4 : 1,
          ...states.webStyle,
          ...(segment.disabled ? { cursor: "default" } : null),
        } as ViewStyle,
      ]}
    >
      <Text
        variant='body'
        weight={active ? "semibold" : "medium"}
        tone={onFill ? "onAccent" : active ? "primary" : "secondary"}
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
            backgroundColor: onFill ? rgba("#000000", 0.2) : color.bg["3"],
          }}
        >
          <Text
            variant='micro'
            weight='semibold'
            tone={onFill ? "onAccent" : "secondary"}
          >
            {String(segment.badge)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
};

/** The strip Server settings, Admin and the arr library put their `Tabs` in. */
export const TabsBar: React.FC<TabsProps> = (props) => {
  const { color } = useTheme();
  const { name } = useBreakpoint();
  const mode = props.layout ?? tabsLayoutFor(name);

  return (
    <View
      style={{
        paddingTop: 12,
        // Underline tabs carry their own bottom padding, so that the rule lands
        // on the strip's edge rather than floating above it.
        paddingBottom: mode === "pills" ? 12 : 0,
        backgroundColor: color.bg["0"],
        borderBottomWidth: 1,
        borderBottomColor: color.border.subtle,
      }}
    >
      <Tabs {...props} />
    </View>
  );
};
