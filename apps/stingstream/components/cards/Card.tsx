import { LinearGradient } from "expo-linear-gradient";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { elevation, rgba, tokens } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import { CardArtwork } from "./CardArtwork";
import {
  CARD_TEXT_GAP,
  CARD_TITLE_LINES,
  type CardData,
  type CardKind,
  type CardSlots,
  defaultTextPlacement,
} from "./CardData";
import { useCardLayout } from "./useCardLayout";

type CardProps = {
  card: CardData;
  kind: CardKind;
  /** Overrides the kind's card width — a grid sizes cards by its columns. */
  width?: number;
  /**
   * Where the title goes. Defaults to the kind's own answer — see
   * `defaultTextPlacement`: "below" for posters, "over" for landscape stills.
   * Pass it only to override that.
   */
  textPlacement?: "over" | "below";
  slots?: Pick<CardSlots, "overlay" | "footer">;
  onPress: () => void;
  onLongPress?: () => void;
};

const isWeb = Platform.OS === "web";

/**
 * A media card. Everything it draws comes from `CardData` — see
 * `buildItemCards`.
 *
 * A poster keeps its artwork clean and puts the title and year below it, on the
 * page's own surface: the poster already carries the title in its bitmap, so a
 * band over it was two overlapping text layers, and secondary grey on an
 * arbitrary photograph has no contrast guarantee. A landscape still is not
 * self-labelling and keeps the frosted band.
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
  textPlacement,
  slots,
  onPress,
  onLongPress,
}) => {
  const layout = useCardLayout(kind);
  const { accent } = useTheme();
  const states = usePressableStates();
  const cardWidth = width ?? layout.cardWidth;
  const height = cardWidth / (card.aspectRatio ?? layout.aspectRatio);
  const progress = Math.min(Math.max(card.progress ?? 0, 0), 1);
  const isOver = (textPlacement ?? defaultTextPlacement(kind)) === "over";
  const lifted = isWeb && states.hovered;

  // Only the banded card draws its bar here, under the title. The clean-art
  // card puts it on the artwork's bottom edge instead (`edgeProgress`), where
  // it sits on the thing it describes rather than floating above the title.
  const bandProgressBar = progress > 0 && (
    <View
      style={{
        height: 3,
        borderRadius: 2,
        marginTop: 5,
        backgroundColor: rgba("#FFFFFF", 0.25),
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

  // The artwork is a photograph, not a flat surface, so hover and press are a
  // wash laid over it rather than a background colour swap — the same wash
  // every other interactive surface uses, from `usePressableStates`.
  const stateWash = states.overlay ? (
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
  ) : null;

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
      // "Title (Year)", the same label the artwork carries — a poster card's
      // title is drawn text now, but a banded one still has it over the image,
      // and a screen reader should hear the same thing either way.
      accessibilityLabel={card.imageAlt ?? card.title}
      onPress={onPress}
      onLongPress={onLongPress}
      {...states.handlers}
      style={[
        {
          width: cardWidth,
          opacity: card.dimmed ? 0.5 : 1,
          transform: [{ scale: lifted ? tokens.motion.hoverScale : 1 }],
        },
        // Cursor, the fast transition and the keyboard focus ring, from the
        // one hook every interactive surface uses.
        states.webStyle,
        isWeb && lifted ? (elevation(1) as ViewStyle) : null,
      ]}
    >
      <View>
        <CardArtwork
          card={card}
          width={cardWidth}
          height={height}
          cornerRadius={layout.cornerRadius}
          edgeProgress={!isOver}
          overlay={
            <>
              {stateWash}
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
              {bandProgressBar}
            </View>
          </>
        )}
      </View>

      {/*
        Title and year on the page's own surface, under clean artwork. Two lines
        before the title ellipses: a poster is 118 px wide on a phone, and one
        line turned most of them into "Sita Sings th…" with the space for a
        second line sitting empty right underneath. The row above reserves both
        lines whether or not this title needs them (`cardTextBlockHeight`), so
        the cards in a row stay aligned.
      */}
      {!isOver && (
        <View style={{ paddingTop: CARD_TEXT_GAP }}>
          <Text
            variant='caption'
            weight='medium'
            numberOfLines={CARD_TITLE_LINES}
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
