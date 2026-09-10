import { Ionicons } from "@expo/vector-icons";
import type {
  BaseItemDto,
  CollectionType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { LinearGradient } from "expo-linear-gradient";
import { useSegments } from "expo-router";
import { useAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Image } from "@/components/common/ServerImage";
import { Text } from "@/components/common/Text";
import { elevation, radius, rgba, tokens } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getPrimaryImageUrl } from "@/utils/jellyfin/image/getPrimaryImageUrl";
import { getItemNavigation, itemRouter } from "../common/TouchableItemRouter";

interface Props {
  library: BaseItemDto;
  /** The card's rendered width — a grid sizes its cards by column count. */
  width: number;
  style?: ViewStyle;
}

type CollectionIconName = React.ComponentProps<typeof Ionicons>["name"];

/** Content-type glyphs have no semantic equivalent in `Icon`'s curated set,
 * so this stays on raw Ionicons, the way the fork's library sidebar always
 * has. */
const icons: Record<CollectionType, CollectionIconName> = {
  movies: "film",
  tvshows: "tv",
  music: "musical-notes",
  books: "book",
  homevideos: "videocam",
  boxsets: "albums",
  playlists: "list",
  folders: "folder",
  livetv: "tv",
  musicvideos: "musical-notes",
  photos: "images",
  trailers: "videocam",
  unknown: "help-circle",
} as const;

const isWeb = Platform.OS === "web";
const ASPECT_RATIO = 16 / 9;

/**
 * A library, drawn as a wide tile with its name underneath.
 *
 * The name sits **below** the artwork, never over it. A library folder's image
 * is not a poster the way a film's is: Jellyfin builds one from whatever is
 * inside, and a seeded or hand-made one may well have the library's own name
 * painted into the bitmap — which is exactly what happened, and put "Movies" on
 * the same card twice. Below the tile, that can't recur whatever the image
 * turns out to be.
 *
 * And the image is only asked for when the folder actually has one.
 * `getPrimaryImageUrl` builds a URL for any item, tag or no tag, so a library
 * nobody has given an image used to render as a flat empty rectangle — the same
 * trap the media cards had. Without a tag this draws its own tile instead: a
 * quiet bg2 → bg3 gradient with the `CollectionType` glyph, which says "TV
 * shows" faster than a collage of four posters does anyway.
 */
export const LibraryItemCard: React.FC<Props> = ({ library, width, style }) => {
  const { color } = useTheme();
  const [api] = useAtom(apiAtom);
  const router = useRouter();
  const segments = useSegments();
  const states = usePressableStates();

  const from = (segments as string[])[2] || "(libraries)";

  /**
   * A real image someone can look at, rather than a URL that happens to
   * resolve. `ImageTags.Primary` is the server saying it holds one.
   */
  const hasOwnImage = Boolean(library.ImageTags?.Primary);

  const url = useMemo(
    () =>
      hasOwnImage
        ? getPrimaryImageUrl({
            api,
            item: library,
            width: Math.round(width * 2),
          })
        : null,
    [api, library, width, hasOwnImage],
  );

  const height = width / ASPECT_RATIO;
  const lifted = isWeb && states.hovered;
  const iconName = icons[library.CollectionType as CollectionType] ?? "folder";
  // Big enough to read as the tile's subject, never taller than the tile.
  const glyphSize = Math.max(24, Math.min(40, Math.round(height * 0.4)));

  const handlePress = useCallback(() => {
    // Mirrors `TouchableItemRouter`: music libraries need the explicit string
    // route or the dynamic `[libraryId]` param is lost inside the nested
    // navigator.
    if (library.CollectionType === "music") {
      router.push(itemRouter(library, from) as any);
      return;
    }
    router.push(getItemNavigation(library, from) as any);
  }, [library, from, router]);

  return (
    <Pressable
      testID='library-card'
      accessibilityRole='button'
      accessibilityLabel={library.Name ?? undefined}
      onPress={handlePress}
      {...states.handlers}
      style={[
        {
          width,
          transform: [{ scale: lifted ? tokens.motion.hoverScale : 1 }],
        },
        states.webStyle,
        isWeb && lifted ? (elevation(1) as ViewStyle) : null,
        style,
      ]}
    >
      <View
        style={{
          width,
          height,
          borderRadius: radius.lg,
          overflow: "hidden",
          backgroundColor: color.bg["2"],
          borderWidth: 0.5,
          borderColor: color.border.subtle,
        }}
      >
        {url ? (
          <>
            <Image
              source={{ uri: url }}
              accessibilityLabel={library.Name ?? undefined}
              cachePolicy='memory-disk'
              contentFit='cover'
              style={{ width: "100%", height: "100%" }}
            />
            {/* On a photograph the glyph needs its own ground to read against;
                on the drawn tile below it does not. */}
            <View
              style={{
                position: "absolute",
                top: 10,
                left: 10,
                width: 30,
                height: 30,
                borderRadius: 15,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: rgba("#000000", 0.5),
              }}
            >
              <Ionicons name={iconName} size={15} color={color.text.primary} />
            </View>
          </>
        ) : (
          <LinearGradient
            colors={[color.bg["2"], color.bg["3"]]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons
              name={iconName}
              size={glyphSize}
              color={color.text.tertiary}
            />
          </LinearGradient>
        )}

        {states.overlay ? (
          <View
            pointerEvents='none'
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: states.overlay,
            }}
          />
        ) : null}
      </View>

      <View style={{ paddingTop: 8 }}>
        <Text variant='body' weight='semibold' numberOfLines={2}>
          {library.Name}
        </Text>
      </View>
    </Pressable>
  );
};
