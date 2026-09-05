import { useState } from "react";
import { Platform, View } from "react-native";
import {
  useCanApproveRequests,
  useRequestCounts,
} from "@/lib/stingstream/requests";
import { SegmentedControlBar } from "../shared/SegmentedControl";
import { ApprovalsSection } from "./ApprovalsSection";
import { DiscoverSection } from "./DiscoverSection";
import { MyRequestsSection } from "./MyRequestsSection";
import { NotificationsSection } from "./NotificationsSection";
import { RequestPolicySection } from "./RequestPolicySection";

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

  const pending = counts.data?.pendingApproval ?? 0;
  const unread = counts.data?.unreadNotifications ?? 0;

  const segments = [
    { key: "discover", label: "Discover" },
    { key: "mine", label: "My requests" },
    {
      key: "alerts",
      label: unread > 0 ? `Alerts (${unread})` : "Alerts",
    },
    ...(canApprove && !Platform.isTV
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
