import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { EmptyState } from "@/components/common/EmptyState";
import useRouter from "@/hooks/useAppRouter";
import { useCanApproveRequests } from "@/lib/stingstream/requests";

/**
 * Where an administrator goes to turn downloading on.
 *
 * Requests can only look a title up through Radarr and Sonarr (`RequestService.CanSearch`), so a
 * node with neither running cannot answer anything on this screen. Downloading is the page holding
 * the switch that starts them, and the only page that can fix this, so it is the honest
 * destination.
 *
 * It used to be `/settings/library?focus=downloading`, back when the switch was a section on top of
 * the arr library and the link had to scroll the page to it. The switch has its own page now, and
 * that library screen no longer exists at all, so there is nothing left to focus.
 *
 * Not "Indexers & engines": that page administers indexers and download clients, which are what a
 * manager uses once it exists. It never mentions the managers themselves.
 */
export const REQUESTS_SETUP_ROUTE = "/settings/downloading";

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
              // Named after the page it opens. `FindSection`'s empty state now points somewhere
              // else — a title search could not find is added by hand on Movies & TV shows — so
              // these two are no longer one destination under two names.
              label: t("home.settings.sections.downloading"),
              icon: "settings",
              onPress: () => router.push(REQUESTS_SETUP_ROUTE),
            }
          : undefined
      }
    />
  );
}
