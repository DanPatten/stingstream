import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/common/EmptyState";
import { RequestsUnavailableError } from "@/lib/stingstream/requests";
import { RequestsNotSetUp } from "./RequestsNotSetUp";

/**
 * What every Requests section shows when its query failed — one component so the five of them
 * (Discover's search, My requests, Approvals, Alerts, Policy) agree on what "it broke" looks like.
 *
 * `RequestsUnavailableError` (a 503 from `RequestsController`) is handed to `RequestsNotSetUp`
 * rather than worded here: "requests are not set up on this server" is a fact about the server, not
 * a transient failure, so there is no Retry button — pressing it would just fail the same way
 * again — and an administrator gets the same link to the page that fixes it that the screen's own
 * gate offers. The gate usually catches this first; a section still can, because a manager can stop
 * between the gate's answer and the section's own query.
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
    return <RequestsNotSetUp />;
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
