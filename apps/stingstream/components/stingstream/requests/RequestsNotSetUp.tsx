import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { EmptyState } from "@/components/common/EmptyState";
import useRouter from "@/hooks/useAppRouter";
import { useCanApproveRequests } from "@/lib/stingstream/requests";

/**
 * Where an administrator goes to find out which managers this node runs.
 *
 * Requests can only look a title up through Radarr and Sonarr (`RequestService.CanSearch`), so a
 * node with neither running cannot answer anything on this screen. "Movie & series managers" is the
 * screen that names them and says so in as many words ("Downloading is not set up on this server."),
 * which makes it the honest destination — and it is already where `FindSection` sends an
 * administrator from its empty state, so the same problem does not lead two ways.
 *
 * Not "Media services": that page administers indexers and download clients, which are what a
 * manager uses once it exists. It never mentions the two managers themselves.
 */
export const REQUESTS_SETUP_ROUTE = "/settings/library";

/**
 * "Requests are not set up on this server."
 *
 * One component for the whole feature, because the sentence has two audiences and only one of them
 * can act on it. A member is told to ask somebody; an administrator is told what is missing and
 * handed the page that fixes it, rather than being sent to read fourteen settings categories for
 * the one that mentions the managers.
 *
 * The screen renders this *instead of* its section bar rather than inside it (see
 * `RequestsScreen`): every section behind those tabs is answered by the same absent managers, so
 * offering six ways to reach six copies of this message is six invitations to conclude the app is
 * broken. `RequestsErrorState` shows the same notice for a 503 that surfaces inside a section
 * anyway — a manager can stop between the gate's answer and a section's query.
 */
export function RequestsNotSetUp() {
  const { t } = useTranslation();
  const router = useRouter();
  const isAdmin = useCanApproveRequests();

  // No button on a television. Setting a node up means an administrator at a keyboard, and the
  // settings tree a remote can reach is a different one (`settings.tv.tsx`) that does not carry
  // this page — a focusable button that led nowhere would be worse than the sentence alone.
  const canOpenSettings = isAdmin && !Platform.isTV;

  return (
    <EmptyState
      icon='warning'
      title={t("requests.unavailable_title")}
      detail={
        isAdmin
          ? t("requests.unavailable_detail_admin")
          : t("requests.unavailable_detail")
      }
      action={
        canOpenSettings
          ? {
              // The same label as the button `FindSection` shows for the same node, because it is
              // the same destination: two names for one screen reads as two screens.
              label: t("home.settings.sections.arr_library"),
              icon: "settings",
              onPress: () => router.push(REQUESTS_SETUP_ROUTE),
            }
          : undefined
      }
    />
  );
}
