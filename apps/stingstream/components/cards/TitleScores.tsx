import { Image } from "expo-image";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Linking,
  Platform,
  Pressable,
  View,
  type ViewStyle,
} from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import type { CardScores } from "./CardData";

/**
 * IMDb's own yellow, and the black it prints on. A brand mark rather than a theme colour: it is the
 * same in all three themes because it is how the reader recognises the source at 11 px.
 */
const IMDB_YELLOW = "#F5C518";
const IMDB_INK = "#000000";

/** Rotten Tomatoes' own line between a fresh tomato and a splat. */
const FRESH_FROM = 60;

const isWeb = Platform.OS === "web";

type Size = "micro" | "caption";

/**
 * A title's IMDb and Rotten Tomatoes scores, side by side.
 *
 * Both are always drawn, with a dash for a score that does not exist or has not arrived: a card that
 * shows one source on one title and the other on the next reads as two different facts, and a line
 * that appears only once the scores land moves everything under it.
 *
 * Text by default. Pass `links` and each score becomes a way out to the page it came from, which is
 * what the request sheet does and a card does not. Dan: *"Linkable on modal only."*
 */
export function TitleScores({
  scores,
  size = "micro",
  links,
}: {
  scores: CardScores;
  size?: Size;
  links?: { imdb: string; rottenTomatoes: string };
}) {
  const { t } = useTranslation();
  const glyph = size === "micro" ? 11 : 14;

  // A provider answers 0 for a title nobody has voted on, and "0.0" reads as a verdict.
  const imdb =
    scores.imdb != null && scores.imdb > 0 ? scores.imdb.toFixed(1) : null;
  // Zero is a real Tomatometer, so only a missing one is a dash.
  const tomatoes = scores.rottenTomatoes;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: size === "micro" ? 8 : 14,
      }}
    >
      <Score
        size={size}
        href={links?.imdb}
        label={
          imdb
            ? t("requests.score_imdb", { score: imdb })
            : t("requests.score_imdb_none")
        }
        mark={<ImdbMark height={glyph} />}
        value={imdb ?? "–"}
      />
      <Score
        size={size}
        href={links?.rottenTomatoes}
        label={
          tomatoes != null
            ? t("requests.score_rotten_tomatoes", { score: tomatoes })
            : t("requests.score_rotten_tomatoes_none")
        }
        mark={
          <Image
            source={
              tomatoes != null && tomatoes < FRESH_FROM
                ? require("@/assets/images/rt_rotten.svg")
                : require("@/assets/images/rt_fresh.svg")
            }
            style={{
              width: glyph,
              height: glyph,
              opacity: tomatoes == null ? 0.4 : 1,
            }}
          />
        }
        value={tomatoes != null ? `${tomatoes}%` : "–"}
      />
    </View>
  );
}

function Score({
  size,
  href,
  label,
  mark,
  value,
}: {
  size: Size;
  href?: string;
  label: string;
  mark: ReactNode;
  value: string;
}) {
  // `hovered` is absent from `PressableStateCallbackType` in these typings even though
  // react-native-web passes it, so it is held here, as `Button` does.
  const [hovered, setHovered] = useState(false);
  const row: ViewStyle = { flexDirection: "row", alignItems: "center", gap: 4 };

  const body = (
    <>
      {mark}
      <Text
        variant={size}
        tone={size === "micro" ? "tertiary" : "secondary"}
        numberOfLines={1}
      >
        {value}
      </Text>
      {href ? (
        <Icon
          name='openExternal'
          size={size === "micro" ? 9 : 11}
          tone='tertiary'
        />
      ) : null}
    </>
  );

  if (!href) {
    return (
      <View accessible accessibilityLabel={label} style={row}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole='link'
      accessibilityLabel={label}
      onPress={() => void Linking.openURL(href)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        row,
        { opacity: hovered ? 0.7 : 1 },
        isWeb ? ({ cursor: "pointer" } as ViewStyle) : null,
      ]}
    >
      {body}
    </Pressable>
  );
}

/** The IMDb wordmark, drawn rather than shipped: a yellow tab with the name on it. */
function ImdbMark({ height }: { height: number }) {
  return (
    <View
      style={{
        height,
        paddingHorizontal: 2,
        borderRadius: 2,
        backgroundColor: IMDB_YELLOW,
        justifyContent: "center",
      }}
    >
      <Text
        variant='micro'
        style={{
          color: IMDB_INK,
          fontSize: Math.round(height * 0.7),
          lineHeight: height,
          fontWeight: "800",
        }}
      >
        IMDb
      </Text>
    </View>
  );
}
