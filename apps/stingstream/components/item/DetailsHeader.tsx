import type {
  BaseItemDto,
  MediaStream,
} from "@jellyfin/sdk/lib/generated-client/models";
import { LinearGradient } from "expo-linear-gradient";
import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { PageContainer } from "@/components/common/PageContainer";
import { Image } from "@/components/common/ServerImage";
import { Skeleton } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { radius, rgba, tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getBackdropUrl } from "@/utils/jellyfin/image/getBackdropUrl";
import { getLogoImageUrlById } from "@/utils/jellyfin/image/getLogoImageUrlById";
import { getPrimaryImageUrl } from "@/utils/jellyfin/image/getPrimaryImageUrl";
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
  const posterUrl = useMemo(
    () => getPrimaryImageUrl({ api, item, quality: 90, width: 500 }),
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
          backgroundColor: tokens.color.bg["1"],
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
        {/* Two scrims, not one. The vertical fade hands the image to the page
            background so there is no seam; the horizontal one darkens the side
            the text is on, which is the only way white text stays legible over
            an image nobody chose for its contrast. */}
        <LinearGradient
          colors={[
            "transparent",
            rgba(tokens.color.bg["0"], 0.75),
            tokens.color.bg["0"],
          ]}
          locations={[0.35, 0.8, 1]}
          style={FILL}
        />
        <LinearGradient
          colors={[
            rgba(tokens.color.bg["0"], 0.92),
            rgba(tokens.color.bg["0"], 0.15),
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={FILL}
        />
      </View>

      <PageContainer style={{ paddingTop: Math.round(height * 0.42) }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
          <Poster url={posterUrl} name={item.Name} />
          <View style={{ flex: 1, marginLeft: 28, paddingBottom: 4 }}>
            {body}
          </View>
        </View>
      </PageContainer>
    </View>
  );
};

const Poster: React.FC<{ url?: string | null; name?: string | null }> = ({
  url,
  name,
}) => {
  const { t } = useTranslation();
  const height = Math.round(POSTER_WIDTH / POSTER_ASPECT);

  return (
    <View
      style={{
        width: POSTER_WIDTH,
        height,
        borderRadius: radius.lg,
        overflow: "hidden",
        backgroundColor: tokens.color.bg["2"],
        borderWidth: 1,
        borderColor: tokens.color.border.subtle,
      }}
    >
      {url ? (
        <Image
          source={url}
          style={{ width: "100%", height: "100%" }}
          contentFit='cover'
          cachePolicy='memory-disk'
          transition={300}
          accessibilityLabel={t("item.poster_for", { name })}
        />
      ) : (
        <Skeleton width={POSTER_WIDTH} height={height} radius={radius.lg} />
      )}
    </View>
  );
};

/**
 * The title, as the studio's own lettering where the server has it.
 *
 * A logo replaces the words rather than sitting above them — pass-02 drew both,
 * plus a clapperboard glyph, which is three titles for one film. `maxWidth`
 * keeps a wide wordmark from running the whole measure of a 1440 px page.
 */
const TitleBlock: React.FC<{
  item: BaseItemDto;
  logoUrl: string | null;
  compact: boolean;
}> = ({ item, logoUrl, compact }) => {
  const { t } = useTranslation();

  if (logoUrl) {
    return (
      <Image
        source={logoUrl}
        style={{
          height: compact ? 76 : 104,
          width: "100%",
          maxWidth: compact ? undefined : 420,
          alignSelf: "flex-start",
        }}
        contentFit='contain'
        contentPosition='left center'
        cachePolicy='memory-disk'
        transition={300}
        accessibilityLabel={item.Name ?? undefined}
      />
    );
  }

  return (
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
  );
};
