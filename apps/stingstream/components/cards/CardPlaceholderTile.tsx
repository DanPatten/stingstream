import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { tokens } from "@/constants/theme";
import type { CardPlaceholder } from "./CardData";

/**
 * Content-type glyphs, on raw Ionicons rather than `components/common/Icon`.
 *
 * `Icon`'s registry is semantic — what an icon *means* as an action or a
 * destination — and has no film/series/album entry, because a content type is
 * not an action. `components/library/LibraryItemCard.tsx` reached the same
 * conclusion for the same reason and carries the same kind of map. Adding these
 * to `Icon` is WP0's call, not this package's.
 */
const GLYPHS: Record<
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
  /** The card's title — its first letter is what the tile shows. */
  title: string;
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
 * deliberate tile instead: the surface a card sits on one step lighter (`bg2`),
 * the item type's glyph, and the title's first letter — enough to tell a
 * missing poster from a missing *item*, and enough to tell two imageless cards
 * apart at a glance in a grid.
 *
 * Tertiary tone throughout: it is furniture standing in for content, and should
 * never compete with the real posters beside it.
 */
export const CardPlaceholderTile: React.FC<Props> = ({
  title,
  placeholder = "unknown",
  width,
  accessibilityLabel,
}) => {
  // The first *letter*, not the first character: leading quotes and brackets
  // sort into titles often enough to matter ("[Unsorted]", "'71").
  const initial = (title.match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();

  // A poster tile and a 16:9 still are very different widths; both want a glyph
  // that reads without swallowing the letter under it.
  const glyphSize = Math.max(16, Math.min(32, Math.round(width * 0.18)));

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        backgroundColor: tokens.color.bg["2"],
      }}
    >
      <Ionicons
        name={GLYPHS[placeholder]}
        size={glyphSize}
        color={tokens.color.text.tertiary}
      />
      <Text variant='heading' weight='bold' tone='tertiary' numberOfLines={1}>
        {initial}
      </Text>
    </View>
  );
};
