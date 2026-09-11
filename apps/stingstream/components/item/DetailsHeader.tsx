import type {
  BaseItemDto,
  MediaStream,
} from "@jellyfin/sdk/lib/generated-client/models";
import { LinearGradient } from "expo-linear-gradient";
import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { cardPlaceholder } from "@/components/cards/CardData";
import { CardPlaceholderTile } from "@/components/cards/CardPlaceholderTile";
import { PageContainer } from "@/components/common/PageContainer";
import { Image } from "@/components/common/ServerImage";
import { Text } from "@/components/common/Text";
import { radius, rgba } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getBackdropUrl } from "@/utils/jellyfin/image/getBackdropUrl";
import { getLogoImageUrlById } from "@/utils/jellyfin/image/getLogoImageUrlById";
import { getPrimaryImageUrl } from "@/utils/jellyfin/image/getPrimaryImageUrl";
import { getPrimaryImageUrlById } from "@/utils/jellyfin/image/getPrimaryImageUrlById";
import { MetadataLine } from "./MetadataLine";

/** The plan's number. Wide enough to read a poster, narrow enough to leave room. */
const POSTER_WIDTH = 220;
const POSTER_ASPECT = 2 / 3;

/**
 * How tall the backdrop is at `medium` and `expanded`.
 *
 * Not a fraction of the window: a 16:9 image across 1440 px is 810 px tall, and
 * a header that fills a laptop screen means the title, the buttons and the
 * overview are all below the fold on the page whose entire job is to let you
 * press Play.
 */
const BACKDROP_HEIGHT = { medium: 380, expanded: 460 } as const;

/**
 * The box the studio's lettering is drawn into, clamped to the space it has.
 *
 * A definite width and height, never a percentage: pass-03 sized the logo
 * `width: "100%"` with `alignSelf: "flex-start"`, which resolved to **zero** on
 * web — a 714 px wordmark laid out at 0×0, so the header showed no title at all
 * (F-50). `contain` with a left content position means any wordmark shape draws
 * inside this box at its own aspect ratio without being stretched to fill it.
 */
const LOGO_BOX = {
  compact: { width: 280, height: 76 },
  wide: { width: 480, height: 120 },
} as const;

/** `position: absolute` over the whole parent, spelled the way RN accepts. */
const FILL = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

interface Props {
  item: BaseItemDto;
  /** The streams the badges describe — the chosen media source, usually. */
  streams?: MediaStream[] | null;
  /** `<ActionRow>`, built by the page that owns the play options. */
  actions?: ReactNode;
  /** A line under the metadata: ratings, awards. */
  meta?: ReactNode;
}

/**
 * The top of a pre-play page: art, title, one line of facts, and Play.
 *
 * Two layouts, one content order. At `medium` and up it is a true **backdrop** —
 * the item's own 16:9 art, faded to `bg0` at the bottom and scrimmed from the
 * left — with the poster inset on top of it. Pass-02 used the *poster* as the
 * backdrop, so a 2:3 image stretched across 1440 px cropped the title lettering
 * into a strip and the page opened on a band of somebody's chin (F-26).
 *
 * On compact the artwork is the parallax header the page already draws, and this
 * component is only the text block under it — same order, same components, no
 * second implementation of the metadata line to drift out of step.
 *
 * Nothing here touches the viewport edge except the backdrop itself: everything
 * else sits inside `PageContainer`'s gutter, which is what the badges hugging
 * the left edge at 390 were missing.
 */
export const DetailsHeader: React.FC<Props> = ({
  item,
  streams,
  actions,
  meta,
}) => {
  const { color } = useTheme();
  const api = useAtomValue(apiAtom);
  const { t } = useTranslation();
  const { isCompact, name: breakpoint } = useBreakpoint();

  const logoUrl = useMemo(
    () => getLogoImageUrlById({ api, item, height: 160 }),
    [api, item],
  );
  const backdropUrl = useMemo(
    () => getBackdropUrl({ api, item, quality: 90, width: 1920 }),
    [api, item],
  );
  // An episode's own Primary image is a 16:9 still, and a 2:3 crop of one is a
  // close-up of whatever happened to be in the middle of the frame. The series
  // poster is the image an episode belongs to.
  const posterUrl = useMemo(
    () =>
      item.Type === "Episode" && item.SeriesId
        ? getPrimaryImageUrlById({ api, id: item.SeriesId, quality: 90 })
        : getPrimaryImageUrl({ api, item, quality: 90, width: 500 }),
    [api, item],
  );

  const title = (
    <TitleBlock item={item} logoUrl={logoUrl} compact={isCompact} />
  );
  const body = (
    <>
      {title}
      <MetadataLine item={item} streams={streams} style={{ marginTop: 10 }} />
      {meta ? <View style={{ marginTop: 8 }}>{meta}</View> : null}
      {actions ? <View style={{ marginTop: 20 }}>{actions}</View> : null}
    </>
  );

  if (isCompact) {
    return (
      <View testID='details-header'>
        <PageContainer style={{ paddingTop: 8 }}>{body}</PageContainer>
      </View>
    );
  }

  const height =
    breakpoint === "expanded"
      ? BACKDROP_HEIGHT.expanded
      : BACKDROP_HEIGHT.medium;

  return (
    <View testID='details-header' style={{ position: "relative" }}>
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height,
          backgroundColor: color.bg["1"],
        }}
      >
        {backdropUrl ? (
          <Image
            source={backdropUrl}
            style={{ width: "100%", height: "100%" }}
            contentFit='cover'
            cachePolicy='memory-disk'
            transition={300}
            accessibilityLabel={t("item.backdrop_for", { name: item.Name })}
          />
        ) : null}
        {/* Three layers, and each earns its place. The flat dim takes the whole
            image down a step so a bright backdrop (a sitcom cast in daylight)
            cannot out-shout the page; the vertical fade hands the image to the
            page background so there is no seam where it ends; the horizontal
            one darkens the side the text is on, which is the only way white
            text stays legible over an image nobody chose for its contrast. */}
        <View
          pointerEvents='none'
          style={[FILL, { backgroundColor: rgba(color.bg["0"], 0.22) }]}
        />
        <LinearGradient
          colors={["transparent", rgba(color.bg["0"], 0.7), color.bg["0"]]}
          locations={[0.3, 0.85, 1]}
          style={FILL}
        />
        <LinearGradient
          colors={[
            rgba(color.bg["0"], 0.88),
            rgba(color.bg["0"], 0.55),
            "transparent",
          ]}
          locations={[0, 0.5, 0.85]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={FILL}
        />
      </View>

      <PageContainer style={{ paddingTop: Math.round(height * 0.42) }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
          <Poster item={item} url={posterUrl} />
          <View style={{ flex: 1, marginLeft: 28, paddingBottom: 4 }}>
            {body}
          </View>
        </View>
      </PageContainer>
    </View>
  );
};

/**
 * The poster, or the tile that stands in for one — never an empty box.
 *
 * `getPrimaryImageUrl` hands back a `/Images/Primary` URL for every item,
 * including the ones the server holds no primary image for, so "there is a URL"
 * is not "there is a poster": the request 404s and the box stays the flat grey
 * of its own background (F-50). A failed load falls back to the same placeholder
 * tile the cards use — the type's glyph and the title's first letter — which
 * reads as "no artwork for this" rather than as artwork still on its way.
 *
 * The skeleton this replaced was the pass-02 defect in miniature: a skeleton is
 * a promise that something is coming, and for an item whose details have already
 * loaded, nothing is.
 */
const Poster: React.FC<{ item: BaseItemDto; url?: string | null }> = ({
  item,
  url,
}) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const height = Math.round(POSTER_WIDTH / POSTER_ASPECT);
  const [failed, setFailed] = useState(false);

  // A new item reuses this component; last item's failure is not this one's.
  useEffect(() => {
    setFailed(false);
  }, [url]);

  const label = t("item.poster_for", { name: item.Name });

  return (
    <View
      testID='details-poster'
      style={{
        width: POSTER_WIDTH,
        height,
        borderRadius: radius.lg,
        overflow: "hidden",
        backgroundColor: color.bg["2"],
        borderWidth: 1,
        borderColor: color.border.subtle,
      }}
    >
      {url && !failed ? (
        <Image
          source={url}
          style={{ width: "100%", height: "100%" }}
          contentFit='cover'
          cachePolicy='memory-disk'
          transition={300}
          onError={() => setFailed(true)}
          accessibilityLabel={label}
        />
      ) : (
        <CardPlaceholderTile
          placeholder={cardPlaceholder(item)}
          width={POSTER_WIDTH}
          accessibilityLabel={label}
        />
      )}
    </View>
  );
};

/**
 * The title, as the studio's own lettering where the server has it — and as
 * words every other second of the page's life.
 *
 * A logo replaces the words rather than sitting above them: pass-02 drew both,
 * plus a clapperboard glyph, which is three titles for one movie. But pass-03
 * showed what "replaces" costs when the replacement never arrives — the logo
 * laid out at 0×0 and the header had **no title at all** (F-50). So the words
 * are what renders until the image says it loaded, and they come back if it
 * fails. There is no state in which this component draws nothing.
 *
 * The image is in the tree the whole time, sized and merely transparent while it
 * loads, because an image that is not laid out is an image the browser has no
 * reason to fetch — and taken out of the flow, so the words below it sit where
 * they would anyway and the swap moves nothing else on the page.
 */
const TitleBlock: React.FC<{
  item: BaseItemDto;
  logoUrl: string | null;
  compact: boolean;
}> = ({ item, logoUrl, compact }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  const [available, setAvailable] = useState(0);

  useEffect(() => {
    setState("loading");
  }, [logoUrl]);

  // An episode's logo is its *series'* logo, so drawing it here would give the
  // page the show's name and never the episode's. The words win.
  const wantsLogo =
    Boolean(logoUrl) && item.Type !== "Episode" && state !== "failed";
  const box = compact ? LOGO_BOX.compact : LOGO_BOX.wide;
  // Clamped to the column it sits in, so the wide box cannot push the page
  // sideways in the narrow gap left beside the poster at the 768 breakpoint.
  const width =
    available > 0 ? Math.min(box.width, Math.round(available)) : box.width;
  const showLogo = wantsLogo && state === "ok";

  return (
    <View
      testID='details-title'
      onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}
      style={{ overflow: "hidden" }}
    >
      {wantsLogo && logoUrl ? (
        <Image
          source={logoUrl}
          style={
            showLogo
              ? { width, height: box.height, alignSelf: "flex-start" }
              : {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width,
                  height: box.height,
                  opacity: 0,
                }
          }
          contentFit='contain'
          contentPosition='left center'
          cachePolicy='memory-disk'
          transition={300}
          onLoad={(event) => {
            // A reported width of exactly zero is a logo that decoded to
            // nothing; anything else (including a platform that reports no
            // dimensions at all) counts as loaded.
            const reported = event?.source?.width;
            setState(
              typeof reported === "number" && reported <= 0 ? "failed" : "ok",
            );
          }}
          onError={() => setState("failed")}
          accessibilityLabel={item.Name ?? undefined}
        />
      ) : null}

      {showLogo ? null : (
        <View>
          <Text variant='display' weight='bold' selectable numberOfLines={2}>
            {item.Name}
          </Text>
          {item.Type === "Episode" && item.SeriesName ? (
            <Text
              variant='heading'
              tone='secondary'
              numberOfLines={1}
              style={{ marginTop: 4 }}
            >
              {t("item.from_series", { name: item.SeriesName })}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
};
