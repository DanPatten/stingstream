import { MaterialCommunityIcons } from "@expo/vector-icons";
import { TouchableOpacity, View, type ViewProps } from "react-native";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { MediaStatus } from "@/utils/jellyseerr/server/constants/media";

interface Props {
  mediaStatus?: MediaStatus;
  showRequestIcon: boolean;
  onPress?: () => void;
}

const BADGE_SIZE = 24;

/**
 * What each status *means*, rather than which hex it used to be.
 *
 * The badge was a table of Tailwind palette classes — indigo for processing,
 * yellow for pending, a purple fill under a green ring for available — copied
 * from Jellyseerr's own web component. None of those colours existed anywhere
 * else in the app, and being classes they could not follow a theme at all.
 *
 * The states map cleanly onto the four the design system already has, so the
 * badge now says which state it is and lets the palette answer.
 */
const BADGE: Partial<
  Record<
    MediaStatus,
    {
      icon: keyof typeof MaterialCommunityIcons.glyphMap;
      tone: "info" | "success" | "warning" | "danger";
    }
  >
> = {
  [MediaStatus.PROCESSING]: { icon: "clock", tone: "info" },
  [MediaStatus.AVAILABLE]: { icon: "check", tone: "success" },
  [MediaStatus.PENDING]: { icon: "bell", tone: "warning" },
  [MediaStatus.BLACKLISTED]: { icon: "eye-off", tone: "danger" },
  [MediaStatus.PARTIALLY_AVAILABLE]: { icon: "minus", tone: "success" },
};

const JellyseerrStatusIcon: React.FC<Props & ViewProps> = ({
  mediaStatus,
  showRequestIcon,
  onPress,
  style,
  ...props
}) => {
  const { color } = useTheme();

  // "Nothing is known about this title yet" is not a state, it is an offer to
  // request one, so it takes the accent rather than a state colour.
  const badge =
    (mediaStatus !== undefined ? BADGE[mediaStatus] : undefined) ??
    (showRequestIcon
      ? ({ icon: "plus", tone: undefined } as const)
      : undefined);
  if (!badge) return null;

  const fill = badge.tone ? color.state[badge.tone] : color.accent[500];

  return (
    <TouchableOpacity onPress={onPress} disabled={onPress === undefined}>
      <View
        style={[
          {
            width: BADGE_SIZE,
            height: BADGE_SIZE,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: fill,
          },
          style,
        ]}
        {...props}
      >
        {/*
          The state colours are all light enough that the page behind them is
          the readable glyph, the same rule the danger button follows.
        */}
        <MaterialCommunityIcons
          name={badge.icon}
          size={16}
          color={color.scheme === "dark" ? color.bg["0"] : color.text.primary}
        />
      </View>
    </TouchableOpacity>
  );
};

export default JellyseerrStatusIcon;
