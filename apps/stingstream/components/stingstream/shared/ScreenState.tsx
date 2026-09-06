import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { Loader } from "@/components/Loader";

/**
 * `EmptyState` now lives in `components/common` so every screen shares one, not
 * just the StingStream ones. Re-exported here so the existing imports keep
 * working; it gained an optional icon and action, both of which default to
 * nothing.
 */
export { EmptyState } from "@/components/common/EmptyState";

export function LoadingState() {
  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 64,
      }}
    >
      <Loader />
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 64,
        paddingHorizontal: 24,
      }}
    >
      <Text variant='body' weight='semibold' tone='danger' align='center'>
        {t("common.something_went_wrong")}
      </Text>
      <Text
        variant='caption'
        tone='secondary'
        align='center'
        style={{ marginTop: 4 }}
      >
        {message}
      </Text>
      {onRetry && (
        <Text
          variant='caption'
          weight='semibold'
          tone='accent'
          style={{ marginTop: 12 }}
          onPress={onRetry}
          accessibilityRole='button'
        >
          {t("common.retry")}
        </Text>
      )}
    </View>
  );
}

/** Renders one of loading / error / children, the pattern every StingStream
 * screen uses for its react-query result. */
export function QueryState({
  isLoading,
  error,
  onRetry,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  if (isLoading) return <LoadingState />;
  if (error)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : String(error)}
        onRetry={onRetry}
      />
    );
  return <>{children}</>;
}
