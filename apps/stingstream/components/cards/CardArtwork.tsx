import { View } from "react-native";
import { Pill } from "@/components/common/Pill";
import { Image } from "@/components/common/ServerImage";
import { tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { CardData } from "./CardData";
import { CardPlaceholderTile } from "./CardPlaceholderTile";

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
  const { accent } = useTheme();
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
        borderColor: tokens.color.border.subtle,
      }}
    >
      {card.imageUrl ? (
        <Image
          id={card.id}
          source={{ uri: card.imageUrl }}
          cachePolicy='memory-disk'
          contentFit='cover'
          accessibilityLabel={card.imageAlt ?? card.title}
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <CardPlaceholderTile
          title={card.title}
          placeholder={card.placeholder}
          width={width}
          accessibilityLabel={card.imageAlt ?? card.title}
        />
      )}

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
