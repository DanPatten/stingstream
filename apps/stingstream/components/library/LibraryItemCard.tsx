import { Ionicons } from "@expo/vector-icons";
import type {
  BaseItemDto,
  CollectionType,
} from "@jellyfin/sdk/lib/generated-client/models";
import { LinearGradient } from "expo-linear-gradient";
import { useSegments } from "expo-router";
import { useAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Image } from "@/components/common/ServerImage";
import { Text } from "@/components/common/Text";
import {
  elevation,
  motion,
  radius,
  rgba,
  tokens,
  webFocusRing,
} from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
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
 * A library, drawn as a wide backdrop card: the library's own image, a
 * translucent disc carrying the `CollectionType` glyph, and the name over a
 * frosted band — the same visual language every other card in the app uses,
 * so "Movies" and "TV Shows" read as tiles in the same system as everything
 * inside them.
 */
export const LibraryItemCard: React.FC<Props> = ({ library, width, style }) => {
  const [api] = useAtom(apiAtom);
  const router = useRouter();
  const segments = useSegments();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const from = (segments as string[])[2] || "(libraries)";

  const url = useMemo(
    () =>
      getPrimaryImageUrl({
        api,
        item: library,
        width: Math.round(width * 2),
      }),
    [api, library, width],
  );

  const height = width / ASPECT_RATIO;
  const lifted = isWeb && hovered;

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
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        {
          width,
          transform: [{ scale: lifted ? tokens.motion.hoverScale : 1 }],
        },
        isWeb
          ? ({
              cursor: "pointer",
              transitionDuration: `${motion.fast}ms`,
              ...(lifted ? elevation(1) : null),
              ...webFocusRing(focused),
            } as ViewStyle)
          : null,
        style,
      ]}
    >
      <View
        style={{
          width,
          height,
          borderRadius: radius.lg,
          overflow: "hidden",
          backgroundColor: tokens.color.bg["2"],
          borderWidth: 0.5,
          borderColor: tokens.color.border.subtle,
        }}
      >
        {url ? (
          <Image
            source={{ uri: url }}
            accessibilityLabel={library.Name ?? undefined}
            cachePolicy='memory-disk'
            contentFit='cover'
            style={{ width: "100%", height: "100%" }}
          />
        ) : null}

        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.85)"]}
          pointerEvents='none'
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: height * 0.6,
            borderBottomLeftRadius: radius.lg,
            borderBottomRightRadius: radius.lg,
          }}
        />

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
          <Ionicons
            name={icons[library.CollectionType!] ?? "folder"}
            size={15}
            color={tokens.color.text.primary}
          />
        </View>

        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 12,
            paddingBottom: 10,
          }}
        >
          <Text variant='body' weight='semibold' numberOfLines={1}>
            {library.Name}
          </Text>
        </View>
      </View>
    </Pressable>
  );
};
