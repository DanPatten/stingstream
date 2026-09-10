import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { CardArtwork } from "@/components/cards/CardArtwork";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import {
  type RequestSearchResult,
  requestTitle,
  searchAction,
  searchBadgeLabel,
  toRequestCard,
} from "@/lib/stingstream/requestsApi";

/** The same thumbnail `RequestCard` uses, so a result and the request it becomes are one shape. */
const POSTER_WIDTH = 56;
const POSTER_HEIGHT = Math.round(POSTER_WIDTH * 1.5);
const POSTER_RADIUS = radius.sm;

/**
 * One thing you could ask for: poster, title, year, what the group already thinks about it, the
 * overview, and a Request button.
 *
 * A row rather than a poster tile, which is what Search used to draw here, for two reasons. The
 * button is **always visible** — the old grid revealed it only under a pointer, which on a screen
 * whose entire purpose is requesting is an affordance that is not there. And a search for a common
 * word comes back as a dozen sequels, re-releases and remakes whose posters are near-identical;
 * the overview is the only thing that tells them apart, and a tile has nowhere to put it.
 *
 * `searchAction` decides the button's label and whether it is offered at all, so a row never
 * promises something {@link RequestSheet} would then refuse. `searchBadgeLabel` answers the same
 * question in two words for the pill beside the title.
 *
 * The container is a plain `View` and the button is the only control in it — the row itself is not
 * pressable. A `Pressable` wrapping the whole row renders as a real `<button>` on web, and a
 * `<button>` inside a `<button>` is invalid HTML that React refuses to render:
 * `.claude/learned-facts/pressable-listitem-cannot-hold-buttons`. Same shape as `RequestCard`,
 * which takes its actions as a slot for exactly this reason.
 */
export function RequestResultRow({
  result,
  onPress,
}: {
  result: RequestSearchResult;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  // No corner badge on a 56px thumbnail: `toRequestCard` sizes `badgeLabel` for a grid tile and it
  // spills past the artwork's edge here. The pill beside the title says the same thing legibly —
  // the same trade `RequestCard` makes for its own state label.
  const card = { ...toRequestCard(result), badgeLabel: null };
  const action = searchAction(result);
  const badge = searchBadgeLabel(result);

  return (
    <View
      testID='requests-result-row'
      accessibilityLabel={requestTitle(result)}
      style={{
        flexDirection: "row",
        gap: 12,
        padding: 12,
        borderRadius: radius.md,
        backgroundColor: tokens.color.bg["1"],
        marginBottom: 8,
      }}
    >
      <CardArtwork
        card={card}
        width={POSTER_WIDTH}
        height={POSTER_HEIGHT}
        cornerRadius={POSTER_RADIUS}
      />

      <View style={{ flex: 1 }}>
        <Text variant='body' weight='semibold' numberOfLines={2}>
          {requestTitle(result)}
        </Text>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 6,
            marginTop: 4,
          }}
        >
          <Pill
            label={
              result.kind === "series"
                ? t("requests.kind_series")
                : t("requests.kind_movie")
            }
            tone='neutral'
            size='sm'
          />
          {badge ? <Pill label={badge} tone='success' size='sm' /> : null}
        </View>

        {/*
          The group-dedupe answer, and the one thing a Seerr cannot say: somebody in the group has
          this already, so asking for it will start no download. Above the overview because it
          changes what the button below means.
        */}
        {result.holders.length > 0 ? (
          <Text variant='caption' tone='secondary' style={{ marginTop: 4 }}>
            {t("requests.held_by", { holders: result.holders.join(", ") })}
          </Text>
        ) : null}

        {result.overview ? (
          <Text
            variant='caption'
            tone='secondary'
            numberOfLines={2}
            style={{ marginTop: 4 }}
          >
            {result.overview}
          </Text>
        ) : null}

        <View style={{ flexDirection: "row", marginTop: 10 }}>
          <Button
            testID='requests-result-request'
            variant='primary'
            size='sm'
            icon='requests'
            disabled={action.disabled}
            onPress={onPress}
            // A screenful of buttons all reading "Request" is a screenful of controls with the
            // same name; the title is what tells a screen reader which one this is.
            accessibilityLabel={t("requests.request_title", {
              title: requestTitle(result),
            })}
          >
            {action.label}
          </Button>
        </View>
      </View>
    </View>
  );
}
