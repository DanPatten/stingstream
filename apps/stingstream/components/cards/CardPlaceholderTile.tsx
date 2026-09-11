import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";

import { useTheme } from "@/hooks/useTheme";
import type { CardPlaceholder } from "./CardData";

/**
 * Content-type glyphs, on raw Ionicons rather than `components/common/Icon`.
 *
 * `Icon`'s registry is semantic — what an icon *means* as an action or a
 * destination — and has no movie/series/album entry, because a content type is
 * not an action. `components/library/LibraryItemCard.tsx` reached the same
 * conclusion for the same reason and carries the same kind of map. Adding these
 * to `Icon` is WP0's call, not this package's.
 */
export const CONTENT_GLYPHS: Record<
  CardPlaceholder,
  React.ComponentProps<typeof Ionicons>["name"]
> = {
  movie: "film-outline",
  series: "tv-outline",
  episode: "tv-outline",
  person: "person-outline",
  music: "musical-notes-outline",
  collection: "albums-outline",
  playlist: "list-outline",
  folder: "folder-outline",
  photo: "image-outline",
  book: "book-outline",
  unknown: "help-circle-outline",
};

type Props = {
  placeholder?: CardPlaceholder;
  /** The artwork rectangle's width, so the glyph scales with the card. */
  width: number;
  /** Screen-reader label, so a card with no poster is not a silent gap. */
  accessibilityLabel?: string;
};

/**
 * What a card draws where its artwork should be.
 *
 * An imageless card used to be a flat near-black rectangle, indistinguishable
 * from a poster that had not loaded yet and from a broken one. This is a
 * deliberate tile instead: the surface a card sits on one step lighter (`bg2`)
 * and the item type's glyph, enough to tell a missing poster from a missing
 * *item*.
 *
 * The glyph alone. The title's first letter used to sit under it, and on a
 * 56px thumbnail beside a title that already says the whole name it read as a
 * second, cruder label for something the row had spelled out twice already.
 * The tile stands in for a picture, so it should look like a picture.
 *
 * Tertiary tone throughout: it is furniture standing in for content, and should
 * never compete with the real posters beside it.
 */
export const CardPlaceholderTile: React.FC<Props> = ({
  placeholder = "unknown",
  width,
  accessibilityLabel,
}) => {
  const { color } = useTheme();

  // A poster tile and a 16:9 still are very different widths. With nothing else
  // in the box the glyph can take a real share of it, rather than the smaller
  // mark it had to be when a letter sat underneath.
  const glyphSize = Math.max(20, Math.min(48, Math.round(width * 0.34)));

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: color.bg["2"],
      }}
    >
      <Ionicons
        name={CONTENT_GLYPHS[placeholder]}
        size={glyphSize}
        color={color.text.tertiary}
      />
    </View>
  );
};
