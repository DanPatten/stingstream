import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/common/EmptyState";
import { RequestsUnavailableError } from "@/lib/stingstream/requests";

/**
 * What every Requests section shows when its query failed — one component so the five of them
 * (Discover's search, My requests, Approvals, Alerts, Policy) agree on what "it broke" looks like.
 *
 * `RequestsUnavailableError` (a 503 from `RequestsController`) gets its own wording rather than the
 * generic one: "requests are not set up on this server" is a fact about the server, not a transient
 * failure, so there is no Retry button — pressing it would just fail the same way again.
 */
export function RequestsErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();

  if (error instanceof RequestsUnavailableError) {
    return (
      <EmptyState
        icon='warning'
        title={t("requests.unavailable_title")}
        detail={t("requests.unavailable_detail")}
      />
    );
  }

  return (
    <EmptyState
      icon='warning'
      title={t("common.something_went_wrong")}
      detail={error instanceof Error ? error.message : String(error)}
      action={
        onRetry ? { label: t("common.retry"), onPress: onRetry } : undefined
      }
    />
  );
}
