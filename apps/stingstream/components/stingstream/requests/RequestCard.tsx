import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { CardArtwork } from "@/components/cards/CardArtwork";
import { Pill, type PillTone } from "@/components/common/Pill";
import { Skeleton } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { ageOf } from "@/lib/stingstream/meshApi";
import {
  type MemberRequest,
  requestTitle,
  seasonsLabel,
  stateLabel,
  stateTone,
  toRequestCard,
} from "@/lib/stingstream/requestsApi";

/** `stateTone`'s four groupings onto the four colors a `Pill` understands. */
const TONE: Record<ReturnType<typeof stateTone>, PillTone> = {
  waiting: "warning",
  working: "info",
  done: "success",
  stopped: "danger",
};

const POSTER_WIDTH = 92;
const POSTER_HEIGHT = Math.round(POSTER_WIDTH * 1.5);
const POSTER_RADIUS = radius.sm;

/** The absolute fallback for a request too old for "2d ago" to mean anything useful. */
const onDate = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/**
 * One request: a small poster, its title and state, who asked and when, the node's own note on
 * why it is where it is, and whatever actions the caller hands in.
 *
 * The actions slot is deliberately generic — `Button variant="ghost"` for Approve/Retry,
 * `variant="danger"` for Decline/Delete — rather than a fixed prop per verb, because My requests
 * offers Delete alone, Approvals offers Approve+Decline for a pending row and Retry for a failed
 * one, and a fixed set of props would grow a boolean per screen.
 */
export function RequestCard({
  request,
  actions,
}: {
  request: MemberRequest;
  actions?: React.ReactNode;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  // No `badgeLabel` on the row's small poster: `toRequestCard` sets it to the state's full label
  // ("Could not be filled", "Waiting for approval"), sized for a Discover grid tile — on a 92 px
  // row thumbnail it has nowhere to fit and spills past the artwork's edge. The `Pill` beside the
  // title already says the same thing at a size that reads.
  const card = { ...toRequestCard(request), badgeLabel: null };
  const tone = TONE[stateTone(request.state)];
  const age = ageOf(request.requestedAt);
  const name = request.requestedByName || t("requests.someone");
  const when = age
    ? age.token
      ? t("requests.requested_when", { name, when: age.token })
      : t("requests.requested_on", { name, date: onDate(age.at) })
    : t("requests.requested_by", { name });

  return (
    <View
      testID='requests-card'
      accessibilityLabel={requestTitle(request)}
      style={{
        flexDirection: "row",
        gap: 12,
        padding: 12,
        borderRadius: radius.md,
        backgroundColor: color.bg["1"],
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
          {requestTitle(request)}
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
          <Pill label={stateLabel(request.state)} tone={tone} size='sm' />
          {request.kind === "series" ? (
            <Text variant='micro' tone='secondary'>
              {seasonsLabel(request.seasons)}
            </Text>
          ) : null}
        </View>
        {request.note ? (
          <Text
            variant='caption'
            tone='secondary'
            numberOfLines={2}
            style={{ marginTop: 4 }}
          >
            {request.note}
          </Text>
        ) : null}
        <Text variant='micro' tone='tertiary' style={{ marginTop: 4 }}>
          {when}
        </Text>
        {actions ? (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            {actions}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The final geometry of one `RequestCard` row, filled with grey blocks while the list loads. */
export function RequestCardSkeleton() {
  const { color } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility='no-hide-descendants'
      style={{
        flexDirection: "row",
        gap: 12,
        padding: 12,
        borderRadius: radius.md,
        backgroundColor: color.bg["1"],
        marginBottom: 8,
      }}
    >
      <Skeleton
        width={POSTER_WIDTH}
        height={POSTER_HEIGHT}
        radius={POSTER_RADIUS}
      />
      <View style={{ flex: 1, justifyContent: "center", gap: 8 }}>
        <Skeleton width='70%' height={14} />
        <Skeleton width={72} height={16} radius={radius.pill} />
        <Skeleton width='45%' height={11} />
      </View>
    </View>
  );
}

/** `count` rows of {@link RequestCardSkeleton}, for the loading state of a request list. */
export function RequestCardSkeletonList({ count = 4 }: { count?: number }) {
  return (
    <View accessibilityRole='progressbar' accessibilityLabel='Loading'>
      {Array.from({ length: count }, (_, index) => (
        <RequestCardSkeleton key={index} />
      ))}
    </View>
  );
}
