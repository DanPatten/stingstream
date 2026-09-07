import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Skeleton } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";

/**
 * `EmptyState` now lives in `components/common` so every screen shares one, not
 * just the StingStream ones. Re-exported here so the existing imports keep
 * working; it gained an optional icon and action, both of which default to
 * nothing.
 */
export { EmptyState } from "@/components/common/EmptyState";

/**
 * A `ListGroup`-shaped stand-in, since every StingStream screen that calls
 * `QueryState` renders one once its data lands. A spinner says "something is
 * happening"; this says roughly what, and holds the layout so nothing jumps
 * when the real rows arrive — the critique's "skeletons, never a spinner" rule.
 */
export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <View
      accessibilityRole='progressbar'
      accessibilityLabel='Loading'
      style={{
        borderRadius: radius.md,
        overflow: "hidden",
        backgroundColor: tokens.color.bg["1"],
      }}
    >
      {Array.from({ length: rows }, (_, index) => (
        <View
          key={index}
          style={{
            padding: 16,
            borderBottomWidth: index < rows - 1 ? 1 : 0,
            borderBottomColor: tokens.color.border.subtle,
          }}
        >
          <Skeleton width='55%' height={14} />
          <Skeleton width='35%' height={11} style={{ marginTop: 8 }} />
        </View>
      ))}
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
  loadingRows,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  onRetry?: () => void;
  /** How many skeleton rows to show while loading. Defaults to 4. */
  loadingRows?: number;
  children: React.ReactNode;
}) {
  if (isLoading) return <LoadingState rows={loadingRows} />;
  if (error)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : String(error)}
        onRetry={onRetry}
      />
    );
  return <>{children}</>;
}
