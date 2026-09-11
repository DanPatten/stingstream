import { useTranslation } from "react-i18next";
import {
  Platform,
  Pressable,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { Button } from "@/components/Button";
import { CardArtwork } from "@/components/cards/CardArtwork";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  type RequestSearchResult,
  requestTitle,
  searchAction,
  searchBadgeLabel,
  toRequestCard,
} from "@/lib/stingstream/requestsApi";

/** The same thumbnail `RequestCard` uses, so a result and the request it becomes are one shape. */
const POSTER_WIDTH = 92;
const POSTER_HEIGHT = Math.round(POSTER_WIDTH * 1.5);
const POSTER_RADIUS = radius.sm;

const isWeb = Platform.OS === "web";

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
 * promises something the node would then refuse. `searchBadgeLabel` answers the same question in
 * two words for the pill beside the title.
 *
 * **The button requests.** It used to open a sheet carrying the same poster, the same overview and
 * a second button also called Request, so asking for a movie meant pressing Request to reach
 * Request. A movie is submitted from here now and `pending` draws the spinner; only a TV show
 * still opens {@link RequestSheet}, because which seasons to ask for is a real choice and this row
 * has nowhere to put it.
 *
 * The container is a plain `View` and the button is the only control in it — the row itself is not
 * pressable. A `Pressable` wrapping the whole row renders as a real `<button>` on web, and a
 * `<button>` inside a `<button>` is invalid HTML that React refuses to render:
 * `.claude/learned-facts/pressable-listitem-cannot-hold-buttons`. Same shape as `RequestCard`,
 * which takes its actions as a slot for exactly this reason.
 */
export function RequestResultRow({
  result,
  pending = false,
  onPress,
}: {
  result: RequestSearchResult;
  /** This row's own request is in flight. Per row, not per screen: a list of spinners would be a lie. */
  pending?: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  // No corner badge on a 92px thumbnail: `toRequestCard` sizes `badgeLabel` for a grid tile and it
  // spills past the artwork's edge here. The pill beside the title says the same thing legibly —
  // the same trade `RequestCard` makes for its own state label.
  const card = { ...toRequestCard(result), badgeLabel: null };
  const action = searchAction(result);
  const badge = searchBadgeLabel(result);
  const openable = action.intent === "manage";

  return (
    <View
      testID='requests-result-row'
      accessibilityLabel={requestTitle(result)}
      style={{
        flexDirection: "row",
        gap: 12,
        padding: 12,
        borderRadius: radius.md,
        backgroundColor: color.bg["1"],
        marginBottom: 8,
      }}
    >
      {/*
        The poster and the title are the second way into the editor, for the reader who reaches for
        the thing itself rather than for the button beside it. Only when there is a request to edit:
        a press here on an untouched title would otherwise *make* a request, which is not what
        clicking a poster means anywhere else.

        Two separate targets rather than one wrapper, and that is not a style choice — a `Pressable`
        around the whole row renders as a real `<button>` on web and the row's own button would then
        be a button inside a button, which React refuses to render outright:
        `.claude/learned-facts/pressable-listitem-cannot-hold-buttons`.
      */}
      <Pressable
        onPress={openable ? onPress : undefined}
        disabled={!openable}
        accessibilityRole={openable ? "button" : undefined}
        accessibilityLabel={openable ? requestTitle(result) : undefined}
        style={isWeb && openable ? ({ cursor: "pointer" } as ViewStyle) : null}
      >
        <CardArtwork
          card={card}
          width={POSTER_WIDTH}
          height={POSTER_HEIGHT}
          cornerRadius={POSTER_RADIUS}
        />
      </Pressable>

      <View style={{ flex: 1 }}>
        <Text
          variant='body'
          weight='semibold'
          numberOfLines={2}
          onPress={openable ? onPress : undefined}
          accessibilityRole={openable ? "button" : undefined}
          style={
            isWeb && openable ? ({ cursor: "pointer" } as TextStyle) : null
          }
        >
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
          {/*
            With a request already open the pill above carries the state and this becomes the thing
            to do about it. Edit for both kinds now: a movie used to get Delete here, on the grounds
            that seasons were the only editable thing and a movie has none, but the sheet carries
            what this server does about the title too — monitoring, quality, removal — and a movie
            has all of those. Deleting the request is inside the sheet, where it sits next to what
            it would undo.

            Secondary rather than primary: managing something you already asked for is not the
            action this screen is for.
          */}
          <Button
            testID='requests-result-request'
            variant={action.intent === "manage" ? "secondary" : "primary"}
            size='sm'
            icon={action.intent === "manage" ? "settings" : "requests"}
            disabled={action.disabled}
            loading={pending}
            onPress={onPress}
            // A screenful of buttons all reading "Request" is a screenful of controls with the
            // same name; the title is what tells a screen reader which one this is.
            accessibilityLabel={t("requests.request_title", {
              title: requestTitle(result),
            })}
          >
            {action.intent === "manage"
              ? t("requests.edit_button")
              : action.label}
          </Button>
        </View>
      </View>
    </View>
  );
}
