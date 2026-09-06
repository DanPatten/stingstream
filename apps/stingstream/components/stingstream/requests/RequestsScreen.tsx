import { Image } from "expo-image";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, View } from "react-native";
import { Text } from "@/components/common/Text";
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
} from "@/lib/stingstream/requests";
import {
  type MemberRequest,
  stateLabel,
  stateTone,
} from "@/lib/stingstream/requestsApi";
import { scaleSize } from "@/utils/scaleSize";
import { SegmentedControlBar } from "../shared/SegmentedControl";
import { ApprovalsSection } from "./ApprovalsSection";
import { DiscoverSection } from "./DiscoverSection";
import { MyRequestsSection } from "./MyRequestsSection";
import { NotificationsSection } from "./NotificationsSection";
import { RequestPolicySection } from "./RequestPolicySection";

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
            reasoning as RequestPieces' Poster.
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
 */
export function RequestsScreen() {
  const canApprove = useCanApproveRequests();
  const counts = useRequestCounts();
  const [section, setSection] = useState("discover");

  // Called before the branch so the hooks above run on both platforms; the TV
  // screen owns its own state because its section list is a different shape.
  if (Platform.isTV) {
    return <TVRequestsScreen />;
  }

  const pending = counts.data?.pendingApproval ?? 0;
  const unread = counts.data?.unreadNotifications ?? 0;

  const segments = [
    { key: "discover", label: "Discover" },
    { key: "mine", label: "My requests" },
    {
      key: "alerts",
      label: unread > 0 ? `Alerts (${unread})` : "Alerts",
    },
    ...(canApprove
      ? [
          {
            key: "approvals",
            label: pending > 0 ? `Approvals (${pending})` : "Approvals",
          },
          { key: "policy", label: "Policy" },
        ]
      : []),
  ];

  return (
    <View>
      <View className='-mx-4 mb-3'>
        <SegmentedControlBar
          segments={segments}
          value={section}
          onChange={setSection}
        />
      </View>

      {section === "discover" && <DiscoverSection />}
      {section === "mine" && <MyRequestsSection />}
      {section === "alerts" && <NotificationsSection />}
      {section === "approvals" && canApprove && <ApprovalsSection />}
      {section === "policy" && canApprove && <RequestPolicySection />}
    </View>
  );
}
