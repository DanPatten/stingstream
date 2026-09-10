import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { View, type ViewProps } from "react-native";
import { radius, rgba } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { MediaType } from "@/utils/jellyseerr/server/constants/media";

/**
 * A chip saying whether a result is a movie or a TV show.
 *
 * It used to be blue for one and purple for the other, which said nothing:
 * neither colour meant anything anywhere else in the app, and the icon inside
 * already carries the distinction. It is one accent-tinted chip now, and the
 * glyph is what tells the two apart.
 */
const JellyseerrMediaIcon: React.FC<
  { mediaType: "tv" | "movie" } & ViewProps
> = ({ mediaType, style, ...props }) => {
  const { color } = useTheme();
  if (!mediaType) return null;

  return (
    <View
      style={[
        {
          borderWidth: 1,
          borderRadius: radius.pill,
          padding: 4,
          backgroundColor: rgba(color.accent[500], 0.9),
          borderColor: rgba(color.accent[400], 0.4),
        },
        style,
      ]}
      {...props}
    >
      {mediaType === MediaType.MOVIE ? (
        <MaterialCommunityIcons
          name='movie-open'
          size={16}
          color={color.accent.onAccent}
        />
      ) : (
        <Feather size={16} name='tv' color={color.accent.onAccent} />
      )}
    </View>
  );
};

export default JellyseerrMediaIcon;
