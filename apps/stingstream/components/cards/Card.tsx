import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import {
  elevation,
  motion,
  rgba,
  tokens,
  webFocusRing,
} from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { CardArtwork } from "./CardArtwork";
import type { CardData, CardKind, CardSlots } from "./CardData";
import { useCardLayout } from "./useCardLayout";

type CardProps = {
  card: CardData;
  kind: CardKind;
  /** Overrides the kind's card width — a grid sizes cards by its columns. */
  width?: number;
  /**
   * Where the title goes. "over" is the poster card: text on the artwork
   * behind a frosted band. "below" leaves the artwork clean and stacks the
   * text underneath, for rows that carry more than two lines.
   */
  textPlacement?: "over" | "below";
  slots?: Pick<CardSlots, "overlay" | "footer">;
  onPress: () => void;
  onLongPress?: () => void;
};

const isWeb = Platform.OS === "web";

/**
 * A media card: artwork edge to edge, the title and subtitle over a frosted
 * band at the bottom, and the progress bar under them but still on the card.
 * Everything it draws comes from `CardData` — see `buildItemCards`.
 *
 * On web the card lifts on hover (scale + shadow) with a play-glyph overlay
 * so a row of stills reads as playable rather than as a photo grid, and a
 * keyboard tab shows the same accent focus ring every other control does.
 * Touch platforms get none of that: hover doesn't exist there, and a
 * `Pressable`'s own press-opacity already answers "did my tap land".
 */
export const Card: React.FC<CardProps> = ({
  card,
  kind,
  width,
  textPlacement = "over",
  slots,
  onPress,
  onLongPress,
}) => {
  const layout = useCardLayout(kind);
  const { accent } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const cardWidth = width ?? layout.cardWidth;
  const height = cardWidth / (card.aspectRatio ?? layout.aspectRatio);
  const progress = Math.min(Math.max(card.progress ?? 0, 0), 1);
  const isOver = textPlacement === "over";
  const lifted = isWeb && hovered;

  const progressBar = progress > 0 && (
    <View
      style={{
        height: 3,
        borderRadius: 2,
        marginTop: 5,
        backgroundColor: "rgba(255,255,255,0.25)",
      }}
    >
      <View
        style={{
          height: 3,
          borderRadius: 2,
          width: `${progress * 100}%`,
          backgroundColor: accent[500],
        }}
      />
    </View>
  );

  // The disc reads as "this plays" without a caption; it only makes sense once
  // a pointer is actually hovering, since touch has no equivalent gesture.
  const hoverPlayGlyph = lifted ? (
    <View
      pointerEvents='none'
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: rgba("#000000", 0.5),
        }}
      >
        <Icon name='play' size={20} color='#FFFFFF' />
      </View>
    </View>
  ) : null;

  return (
    <Pressable
      testID='library-card'
      accessibilityRole='button'
      accessibilityLabel={card.title}
      onPress={onPress}
      onLongPress={onLongPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        {
          width: cardWidth,
          opacity: card.dimmed ? 0.5 : 1,
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
      ]}
    >
      <View>
        <CardArtwork
          card={card}
          width={cardWidth}
          height={height}
          cornerRadius={layout.cornerRadius}
          overlay={
            <>
              {hoverPlayGlyph}
              {slots?.overlay?.(card)}
            </>
          }
        />

        {isOver && (
          <>
            {/* Frosted band, faded in from nothing so the text stays readable. */}
            <LinearGradient
              colors={["transparent", "rgba(0,0,0,0.85)"]}
              pointerEvents='none'
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: height * layout.frostFraction,
                borderBottomLeftRadius: layout.cornerRadius,
                borderBottomRightRadius: layout.cornerRadius,
              }}
            />
            <View
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                paddingHorizontal: 10,
                paddingBottom: 9,
              }}
            >
              <Text variant='caption' weight='semibold' numberOfLines={1}>
                {card.title}
              </Text>
              {Boolean(card.subtitle) && (
                <Text variant='micro' tone='secondary' numberOfLines={1}>
                  {card.subtitle}
                </Text>
              )}
              {progressBar}
            </View>
          </>
        )}
      </View>

      {!isOver && (
        <View style={{ paddingTop: 6 }}>
          {progressBar}
          <Text
            variant='caption'
            weight='semibold'
            numberOfLines={2}
            style={{ marginTop: 2 }}
          >
            {card.title}
          </Text>
          {Boolean(card.subtitle) && (
            <Text variant='micro' tone='secondary' numberOfLines={1}>
              {card.subtitle}
            </Text>
          )}
          {Boolean(card.detail) && (
            <Text variant='micro' tone='tertiary' numberOfLines={1}>
              {card.detail}
            </Text>
          )}
        </View>
      )}

      {slots?.footer?.(card)}
    </Pressable>
  );
};
