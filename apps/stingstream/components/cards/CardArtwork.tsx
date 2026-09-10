import { useState } from "react";
import { PixelRatio, View } from "react-native";
import { Pill } from "@/components/common/Pill";
import { Image } from "@/components/common/ServerImage";
import { motion } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { CardData } from "./CardData";
import { CardPlaceholderTile } from "./CardPlaceholderTile";
import { sizedPosterUrl } from "./posterSize";

type Props = {
  card: CardData;
  width: number;
  height: number;
  cornerRadius: number;
  /**
   * Draws the progress bar along the artwork's bottom edge — where it reads as
   * "you are this far into this", right on the thing it describes. A card that
   * keeps the frosted band draws its own inside the band instead, under the
   * title.
   */
  edgeProgress?: boolean;
  /** Full-bleed layer over the artwork — a play glyph, a status icon. */
  overlay?: React.ReactNode;
};

/**
 * The artwork rectangle every card is built on: the image, the placeholder
 * when there is none, the corner badge, and whatever the screen layers on top.
 *
 * `imageUrl` may be a server URL or a `data:` URI — ServerImage resolves auth
 * headers by host, so a hostless source passes straight through.
 */
export const CardArtwork: React.FC<Props> = ({
  card,
  width,
  height,
  cornerRadius,
  edgeProgress = false,
  overlay,
}) => {
  const { color, accent } = useTheme();
  // Keyed on the URL rather than held as a boolean, so a card recycled by a
  // virtualised list onto a different item starts covered again instead of
  // showing the previous poster's "loaded" as if it were this one's.
  const [settled, setSettled] = useState<string | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  // Sized first, because everything downstream treats this string as the
  // identity of "this poster": `settled`, `broken`, and expo-image's own cache
  // key. They have to be looking at the same URL the request actually used.
  const sized = sizedPosterUrl(card.imageUrl, width, PixelRatio.get());
  const imageUrl = sized && sized !== broken ? sized : null;
  const covered = !!imageUrl && settled !== imageUrl;
  const progress = Math.min(Math.max(card.progress ?? 0, 0), 1);
  const unplayed = card.unplayedCount ?? 0;
  const badgeLabel =
    card.badgeLabel ??
    (unplayed > 0 ? (unplayed >= 1000 ? "1k+" : `${unplayed}`) : null);

  return (
    <View
      style={{
        width,
        height,
        borderRadius: cornerRadius,
        overflow: "hidden",
        borderWidth: 0.5,
        borderColor: color.border.subtle,
        // The ground every poster fades up from. Without it the box is whatever
        // is behind the card, so a slow poster read as a hole in the layout.
        backgroundColor: color.bg["2"],
      }}
    >
      {imageUrl ? (
        <Image
          id={card.id}
          source={{ uri: imageUrl }}
          cachePolicy='memory-disk'
          contentFit='cover'
          // No `placeholder`: `card.placeholder` is a content-type glyph for the
          // tile below, not a blurhash, and `CardData` carries no blurhash —
          // half these posters come from TMDB, which does not publish one.
          transition={motion.base}
          accessibilityLabel={card.imageAlt ?? card.title}
          onLoad={() => setSettled(imageUrl)}
          // A poster that 404s keeps its cover and becomes the placeholder tile,
          // which is a deliberate thing to look at rather than a broken-image
          // glyph with the title spelled out beside it.
          onError={() => setBroken(imageUrl)}
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <CardPlaceholderTile
          placeholder={card.placeholder}
          width={width}
          accessibilityLabel={card.imageAlt ?? card.title}
        />
      )}

      {/*
        Held over the image until it has actually loaded.

        On web `accessibilityLabel` becomes the `<img alt>`, and a browser paints
        that text inside the image box for as long as there is nothing to draw —
        so a 56x84 poster in Requests spent its whole load spelling out "The Lord
        of the Rings: The Fellowship of the Ring" in wrapped four-point words.
        The alt text has to stay; it is what a screen reader reads. Covering it
        is the fix, and the cover is the same colour as the box, so what a person
        sees is an empty poster that fills in rather than a paragraph that
        vanishes.
      */}
      {covered ? (
        <View
          pointerEvents='none'
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: color.bg["2"],
          }}
        />
      ) : null}

      {overlay}

      {edgeProgress && progress > 0 && (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 3,
            backgroundColor: "rgba(255,255,255,0.25)",
          }}
        >
          <View
            style={{
              height: 3,
              width: `${progress * 100}%`,
              backgroundColor: accent[500],
            }}
          />
        </View>
      )}

      {/*
        The only corner badge left, and it is always a number that means
        something: episodes you have not watched yet. A single unwatched movie
        used to draw a bare accent dot here — a bright mark on nearly every
        poster in a library, saying nothing you could act on.
      */}
      {badgeLabel ? (
        <Pill
          label={badgeLabel}
          tone='accent'
          emphasis='solid'
          size='sm'
          style={{ position: "absolute", top: 6, right: 6 }}
        />
      ) : null}
    </View>
  );
};
