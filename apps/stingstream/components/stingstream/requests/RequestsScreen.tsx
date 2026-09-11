import { Image } from "expo-image";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, View } from "react-native";
import { PageContainer } from "@/components/common/PageContainer";
import { type Segment, Tabs } from "@/components/common/Tabs";
import { Text } from "@/components/common/Text";
import { LoadingState } from "@/components/stingstream/shared/ScreenState";
import { TVFilterButton } from "@/components/tv";
import { TVFocusablePoster } from "@/components/tv/TVFocusablePoster";
import { useScaledTVCardLayout } from "@/constants/TVCardLayouts";
import { useScaledTVSizes } from "@/constants/TVSizes";
import { useScaledTVTypography } from "@/constants/TVTypography";
import {
  selectMine,
  useCanApproveRequests,
  useCurrentUserId,
  useRequestCounts,
  useRequests,
  useRequestsAvailable,
} from "@/lib/stingstream/requests";
import {
  type MemberRequest,
  type RequestKind,
  stateLabel,
  stateTone,
} from "@/lib/stingstream/requestsApi";
import { scaleSize } from "@/utils/scaleSize";
import { ActivitySection } from "../arr/ActivitySection";
import { ApprovalsSection } from "./ApprovalsSection";
import { DiscoverSection } from "./DiscoverSection";
import { FindSection } from "./FindSection";
import { IndexerNotice } from "./IndexerNotice";
import { MyRequestsSection } from "./MyRequestsSection";
import { NotificationsSection } from "./NotificationsSection";
import { RequestPolicySection } from "./RequestPolicySection";
import { RequestsNotSetUp } from "./RequestsNotSetUp";
import { RequestsWantedSection } from "./RequestsWantedSection";
import {
  type RequestSegmentKey,
  sectionFromRoute,
  visibleRequestSegmentKeys,
} from "./requestsSections";

/** The same four tones the phone pills use, so a state means one thing everywhere. */
const TV_TONE_STYLES: Record<
  ReturnType<typeof stateTone>,
  { background: string; text: string }
> = {
  waiting: { background: "#3a3320", text: "#F5C451" },
  working: { background: "#1e3350", text: "#5FA8FF" },
  done: { background: "#1d3626", text: "#5FD08A" },
  stopped: { background: "#3a2222", text: "#FF6B6B" },
};

/**
 * One request, as a portrait card.
 *
 * The phone screen lists requests as rows, which is right for a thumb and
 * wrong for a remote: a row of text is unreadable at ten feet and a list of
 * them gives the D-pad one long column to walk. The same requests as posters
 * read at a glance, and the state -- the only thing a viewer actually came to
 * check -- goes in the corner slot rather than at the end of a sentence.
 */
function TVRequestCard({ request }: { request: MemberRequest }) {
  const typography = useScaledTVTypography();
  const card = useScaledTVCardLayout("portrait");
  const tone = TV_TONE_STYLES[stateTone(request.state)];

  return (
    <View style={{ width: card.cardWidth }}>
      {/*
        Focusable although it does nothing on press: a card the D-pad cannot
        land on is a card the viewer cannot read the title of, because the
        title truncates and there is no other way to bring it forward. Pressing
        is a no-op rather than a route, since there is no per-request screen --
        withdrawing is a phone job, as the screen's own comment says.
      */}
      <TVFocusablePoster onPress={() => {}}>
        <View
          style={{
            width: card.cardWidth,
            aspectRatio: card.aspectRatio,
            borderRadius: card.borderRadius,
            overflow: "hidden",
            backgroundColor: "#1a1a1a",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/*
            Plain expo-image, not ServerImage: the poster URL is TMDB's or
            TheTVDB's own CDN via the arr lookup, so attaching this node's
            Jellyfin auth headers would leak them to a third party. Same
            reasoning `CardArtwork`/`ServerImage` rely on for the phone/web
            cards this screen's Discover and Alerts sections now share.
          */}
          {request.posterUrl ? (
            <Image
              source={{ uri: request.posterUrl }}
              style={{ width: "100%", height: "100%" }}
              contentFit='cover'
              cachePolicy='memory-disk'
            />
          ) : (
            <Text
              style={{
                fontSize: typography.title,
                color: "#6b6b70",
                fontWeight: "600",
              }}
            >
              {(request.title.trim()[0] ?? "?").toUpperCase()}
            </Text>
          )}

          {/* The corner slot: the same place a watched tick or a "Now playing"
              badge sits on a poster elsewhere, so the eye already knows to look. */}
          <View
            style={{
              position: "absolute",
              top: scaleSize(12),
              left: scaleSize(12),
              borderRadius: scaleSize(999),
              paddingHorizontal: scaleSize(14),
              paddingVertical: scaleSize(6),
              backgroundColor: tone.background,
            }}
          >
            <Text
              style={{
                fontSize: typography.callout,
                fontWeight: "600",
                color: tone.text,
              }}
            >
              {stateLabel(request.state)}
            </Text>
          </View>
        </View>
      </TVFocusablePoster>

      <Text
        numberOfLines={card.titleLines}
        style={{
          fontSize: typography.callout,
          color: "#FFFFFF",
          marginTop: scaleSize(12),
          fontWeight: "500",
        }}
      >
        {request.title}
      </Text>
      {request.year ? (
        <Text
          style={{
            fontSize: typography.callout,
            color: "#9CA3AF",
            marginTop: scaleSize(4),
          }}
        >
          {request.year}
        </Text>
      ) : null}
    </View>
  );
}

/** The member's own requests as a wrapping grid of portrait cards. */
function TVMyRequests() {
  const { t } = useTranslation();
  const typography = useScaledTVTypography();
  const card = useScaledTVCardLayout("portrait");
  const requests = useRequests({ mine: true });
  const userId = useCurrentUserId();
  const mine = selectMine(requests.data, userId);

  if (mine.length === 0) {
    return (
      <Text style={{ fontSize: typography.body, color: "#737373" }}>
        {t("common.no_results")}
      </Text>
    );
  }

  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: card.spacing,
      }}
    >
      {mine.map((request) => (
        <TVRequestCard key={request.id} request={request} />
      ))}
    </View>
  );
}

/**
 * Requests on a television.
 *
 * The section bar is `TVFilterButton` pills rather than the phone's segmented
 * control, which is a touch target with no focus state at all, and exactly one
 * of them -- the first -- carries `hasTVPreferredFocus`: two candidates is the
 * focus flicker documented in docs/conventions/tv.md.
 *
 * Approvals and Policy are absent here, and Discover keeps its phone rendering
 * for now: searching needs a keyboard, and the sections behind it belong to
 * whoever owns the request components rather than to the TV shell.
 */
function TVRequestsScreen() {
  const { t } = useTranslation();
  const sizes = useScaledTVSizes();
  const typography = useScaledTVTypography();
  const counts = useRequestCounts();
  const available = useRequestsAvailable();
  const [section, setSection] = useState("discover");

  const unread = counts.data?.unreadNotifications ?? 0;

  const sections = [
    { key: "discover", label: t("tv.requests.discover") },
    { key: "mine", label: t("tv.requests.mine") },
    {
      key: "alerts",
      label:
        unread > 0
          ? t("tv.requests.alerts_count", { count: unread })
          : t("tv.requests.alerts"),
    },
  ];

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: sizes.layout.contentInsetTop,
        paddingBottom: sizes.gaps.large,
        paddingLeft: sizes.layout.contentInsetLeft,
        paddingRight: sizes.padding.horizontal,
      }}
      showsVerticalScrollIndicator={false}
    >
      <Text
        style={{
          fontSize: typography.title,
          fontWeight: "700",
          color: "#FFFFFF",
          marginBottom: sizes.gaps.item,
        }}
      >
        {t("tabs.requests")}
      </Text>

      {/* The same gate the phone screen uses, and for the sharper reason: the
          pills are the focus targets, so a node with no managers would greet a
          remote with three of them, each leading to the same sentence. Drawing
          the sentence and no pills leaves the D-pad the one thing it can
          usefully do here, which is go back.
          Nothing at all while the probe is in flight, rather than pills that
          might be replaced a moment later: the first pill carries
          `hasTVPreferredFocus`, and pulling a focused view out from under the
          focus engine is the flicker docs/conventions/tv.md warns about. */}
      {available.isLoading ? null : available.data === false ? (
        <RequestsNotSetUp />
      ) : (
        <>
          <View
            style={{
              flexDirection: "row",
              gap: sizes.gaps.small,
              marginBottom: sizes.gaps.section,
            }}
          >
            {sections.map((entry, index) => (
              <TVFilterButton
                key={entry.key}
                label=''
                value={entry.label}
                onPress={() => setSection(entry.key)}
                hasTVPreferredFocus={index === 0}
                hasActiveFilter={section === entry.key}
              />
            ))}
          </View>

          {section === "discover" && <DiscoverSection />}
          {section === "mine" && <TVMyRequests />}
          {section === "alerts" && <NotificationsSection />}
        </>
      )}
    </ScrollView>
  );
}

/**
 * Requests: the one StingStream screen every member gets, not only administrators.
 *
 * Manage, Downloads and Server settings are administrator-only because every endpoint behind them
 * is `RequiresElevation`. Requests is deliberately not: searching, asking, and watching your own
 * requests need nothing but a Jellyfin account, and the whole point of the feature is that somebody
 * who cannot administer the node can still ask it for something. Only Approvals and Policy are
 * elevated, and they are simply absent for everybody else rather than being a screen that answers
 * 403.
 *
 * On TV this renders the read-only half — Discover and My requests — because approving a request
 * and editing a policy on a remote control is worse than doing it on the phone that is already in
 * the room. Same reasoning as the Manage and Downloads tabs being hidden there entirely.
 *
 * The open section is the `tab` route param, not component state: a reload, a bookmark, a link
 * pasted to somebody else and a return to the page all read the URL back, and six sections sharing
 * one address answer none of them. `onSelectTab` writes it — the page owns the router, as
 * it does for `q` — and `sectionFromRoute` reads it back, narrowed to the sections this member
 * actually has.
 *
 * `term` is the `q` route param, handed over by Search's `Request "…"` button. It picks Find when
 * `tab` is silent: somebody who arrives at Requests with a movie's name is asking for it, not
 * filtering their own list.
 *
 * `kind` is the `kind` route param, handed over by an empty Movies or TV shows library. It narrows
 * Find's bar on arrival rather than choosing a section, because the entry point that sets it always
 * names `tab=find` as well: it says what is being asked for, not where to ask.
 */
export function RequestsScreen({
  tab,
  term = "",
  kind,
  onSelectTab,
}: {
  tab?: string;
  term?: string;
  kind?: RequestKind;
  onSelectTab?: (key: string) => void;
} = {}) {
  const { t } = useTranslation();
  const canApprove = useCanApproveRequests();
  const counts = useRequestCounts();
  const available = useRequestsAvailable();
  // The same query My requests itself runs, so the badge costs no extra poll: React Query hands
  // both callers one entry. It is read rather than `counts.mineOpen` because that number counts
  // only what is still in flight, and a request that was declined or could not be filled is
  // exactly the kind this member most needs telling about.
  const userId = useCurrentUserId();
  const myRequests = useRequests({ mine: true });

  // Called before the branch so the hooks above run on both platforms; the TV
  // screen owns its own state because its section list is a different shape,
  // and because a television has no address bar to match — writing a param on
  // every pill press would re-render the screen under the focus engine for
  // nothing (docs/conventions/tv.md).
  if (Platform.isTV) {
    return <TVRequestsScreen />;
  }

  const pending = counts.data?.pendingApproval ?? 0;
  const unread = counts.data?.unreadNotifications ?? 0;
  const wantedCount = counts.data?.wanted ?? 0;
  // Undefined until counts arrive, and treated as automatic until then, so the tab bar does not
  // flicker an approvals queue in and straight back out on a manual node. The loading gate below
  // holds the screen for the first fetch; this covers a refetch.
  const manual = counts.data?.requestsMode === "manual";
  // Everything of this member's own that is not finished: waiting, approved, downloading, declined,
  // failed. Not the whole list — a title that arrived is over, and a badge that counts things
  // nobody has to do anything about only ever goes up, which is how a badge stops being read.
  const mineOpen = selectMine(myRequests.data, userId).filter(
    (request) => request.state !== "available",
  ).length;

  // Find is first, and it is the one tab every other entry point aims at. It
  // was removed once (F-73) in favour of the Search tab answering one box with
  // both halves, and that left the Requests screen with no way to request at
  // all: a button that navigated to another tab, where the catalogue results
  // carried a Request button that only appeared under a pointer and a section
  // that drew nothing whatever when the node's lookup came back empty. A
  // screen whose whole purpose is asking has to be able to ask.
  // The elevated half is appended rather than nested. Activity joined it when the Manage tab was
  // folded in: a request that is `fulfilling` is a row in the transfer queue, and checking whether
  // one had landed used to mean visiting a second tab. `canApprove` is `IsAdministrator`, which is
  // also the gate every endpoint behind Activity requires.
  //
  // Which of them appear is a pure function, so it can be tested without rendering anything, and so
  // the one rule that matters is visible in one place: with no indexer there is nothing to approve,
  // so the queue becomes a plain list of what people want and the policy governing it goes with it.
  const badges: Partial<Record<RequestSegmentKey, number>> = {
    mine: mineOpen,
    alerts: unread,
    approvals: pending,
    wanted: wantedCount,
  };
  const segments: Segment[] = visibleRequestSegmentKeys(canApprove, manual).map(
    (key) => ({
      key,
      label: t(`requests.tab_${key}`),
      badge: (badges[key] ?? 0) > 0 ? badges[key] : undefined,
    }),
  );

  // Derived, never held: the URL is the one place the open section is written
  // down, so there is no second copy to fall out of step with it.
  const section = sectionFromRoute(segments, tab, term);
  const select = (key: string) => onSelectTab?.(key);

  // The gate, ahead of the section bar rather than inside it.
  //
  // Every one of those six sections is answered by the same two managers, so on a node that has
  // neither there is nothing behind any of them: Find could not look a title up, My requests and
  // Alerts are permanently empty, and Approvals, Activity and Policy administer machinery that is
  // not running. Drawing the tabs anyway gave a reader six things to try before the seventh told
  // them why, and the one section that said so said it only after they had typed a search.
  //
  // `data === false` specifically, not `!data`: a probe still in flight shows the skeleton, and a
  // probe that failed for some other reason (`fetchRequestsAvailable` treats everything but a 503
  // as available) lets the screen through to sections that can report what actually broke.
  //
  // `isLoading`, not `isPending`: the query is disabled until a server is connected, and a disabled
  // query is pending forever — this screen would have held a skeleton up for the whole session.
  // Counts as well as availability: the tab bar's shape depends on them, and drawing Approvals and
  // Policy for a moment before replacing them with Wanted is worse than a beat of nothing.
  if (available.isLoading || counts.isLoading) {
    return (
      <PageContainer width='media'>
        <LoadingState rows={3} />
      </PageContainer>
    );
  }

  if (available.data === false) {
    return (
      <PageContainer width='media'>
        <RequestsNotSetUp />
      </PageContainer>
    );
  }

  return (
    <PageContainer width='media'>
      {/*
        Above the tabs, because it is true of every one of them: a request made from Find, a row
        waiting in My requests and a queue in Activity are all waiting on the same indexer. It
        renders nothing at all unless there is something wrong and the reader can fix it.
      */}
      <IndexerNotice />
      <View testID='requests-tabs'>
        <Tabs
          segments={segments}
          value={section}
          onChange={select}
          contentInset={0}
          style={{ marginBottom: 16 }}
        />
      </View>

      {section === "find" && <FindSection term={term} kind={kind} />}
      {section === "mine" && (
        <MyRequestsSection onFind={() => select("find")} />
      )}
      {section === "alerts" && <NotificationsSection />}
      {section === "approvals" && canApprove && <ApprovalsSection />}
      {section === "wanted" && canApprove && <RequestsWantedSection />}
      {section === "activity" && canApprove && <ActivitySection />}
      {section === "policy" && canApprove && <RequestPolicySection />}
    </PageContainer>
  );
}
