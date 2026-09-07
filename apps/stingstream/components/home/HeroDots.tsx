import { useTranslation } from "react-i18next";
import { Pressable, type StyleProp, View, type ViewStyle } from "react-native";
import { motion, radius, rgba } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

export interface HeroDotsProps {
  count: number;
  /** Zero-based. */
  activeIndex: number;
  onPressIndex: (index: number) => void;
  /**
   * Whether a dot is something to click.
   *
   * Only where there is a pointer and room for one. On a phone the hero is
   * paged by swiping it, and ten 6 px dots pretending to be buttons would be
   * ten targets a finger cannot hit — ten dots at the 44 px minimum is 440 px,
   * wider than the screen they would sit on. So on touch they are what they
   * look like: an indicator of where you are, announced once as a whole.
   */
  interactive: boolean;
  style?: StyleProp<ViewStyle>;
}

const DOT_SIZE = 6;
const ACTIVE_WIDTH = 18;
/** A pointer is precise, but not 6 px precise. */
const HIT_SLOP = { top: 12, bottom: 12, left: 6, right: 6 };

/**
 * Where you are in the hero, and — with a pointer — a way to get somewhere
 * else.
 *
 * The active dot stretches into a short bar rather than only changing colour,
 * so position survives being read at a glance, in a screenshot, or by somebody
 * who cannot separate teal from grey.
 */
export const HeroDots: React.FC<HeroDotsProps> = ({
  count,
  activeIndex,
  onPressIndex,
  interactive,
  style,
}) => {
  const { t } = useTranslation();
  const { accent } = useTheme();

  if (count <= 1) return null;

  const dotStyle = (isActive: boolean): ViewStyle =>
    ({
      width: isActive ? ACTIVE_WIDTH : DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: radius.pill,
      backgroundColor: isActive ? accent[500] : rgba("#FFFFFF", 0.45),
      transitionDuration: `${motion.fast}ms`,
    }) as ViewStyle;

  const indices = Array.from({ length: count }, (_, index) => index);
  const row: ViewStyle = { flexDirection: "row", alignItems: "center", gap: 6 };

  if (!interactive) {
    return (
      <View
        // One element, one sentence — not ten unlabelled shapes.
        accessibilityRole='text'
        accessibilityLabel={t("home.hero.position", {
          index: activeIndex + 1,
          count,
        })}
        style={[row, style]}
      >
        {indices.map((index) => (
          <View key={index} style={dotStyle(index === activeIndex)} />
        ))}
      </View>
    );
  }

  return (
    <View style={[row, style]}>
      {indices.map((index) => {
        const isActive = index === activeIndex;
        return (
          <Pressable
            key={index}
            accessibilityRole='button'
            accessibilityLabel={t("home.hero.go_to_slide", {
              index: index + 1,
              count,
            })}
            accessibilityState={{ selected: isActive }}
            // `accessibilityState.selected` only becomes `aria-selected` for
            // roles that can be selected, and a button is not one of them —
            // so on web "which of these is the current slide" needs saying
            // outright, or every dot reads identically.
            aria-current={isActive ? "true" : undefined}
            hitSlop={HIT_SLOP}
            onPress={() => onPressIndex(index)}
            style={dotStyle(isActive)}
          />
        );
      })}
    </View>
  );
};
