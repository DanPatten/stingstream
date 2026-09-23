import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/common/EmptyState";

/**
 * A request list whose filters matched nothing, with the one way out.
 *
 * Its own component because three lists answer it identically, and a filtered-empty list that read
 * like "you have no requests" is the confusion the bar exists to prevent.
 */
export function RequestsFilteredEmpty({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon='requests'
      title={t("requests.list_filtered_empty_title")}
      action={{
        label: t("requests.list_filtered_clear"),
        icon: "close",
        onPress: onClear,
      }}
    />
  );
}
