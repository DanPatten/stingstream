import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Skeleton } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { queryPhase } from "./queryPhase";

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
  const { color } = useTheme();
  return (
    <View
      accessibilityRole='progressbar'
      accessibilityLabel='Loading'
      style={{
        borderRadius: radius.md,
        overflow: "hidden",
        backgroundColor: color.bg["1"],
      }}
    >
      {Array.from({ length: rows }, (_, index) => (
        <View
          key={index}
          style={{
            padding: 16,
            borderBottomWidth: index < rows - 1 ? 1 : 0,
            borderBottomColor: color.border.subtle,
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

/**
 * What a screen shows when its node cannot be reached at all.
 *
 * Shaped like `ErrorState` but it is not an error: nothing went wrong here, the request was never
 * made. Saying "Something went wrong" for a server that is simply off is a small lie that sends
 * the reader looking in the wrong place.
 */
export function UnavailableState({ onRetry }: { onRetry?: () => void }) {
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
      <Text variant='body' weight='semibold' align='center'>
        {t("common.server_not_answering")}
      </Text>
      <Text
        variant='caption'
        tone='secondary'
        align='center'
        style={{ marginTop: 4 }}
      >
        {t("common.server_not_answering_detail")}
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

/** Renders one of loading / error / unavailable / children, the pattern every StingStream
 * screen uses for its react-query result.
 *
 * Pass `isPending` and `fetchStatus` — easiest via `stateOf(query)` — and a query that was never
 * allowed to run says so instead of rendering children that have nothing to draw. Omitting them
 * keeps the old two-branch behaviour. See `queryPhase.ts` for why that third state exists. */
export function QueryState({
  isLoading,
  error,
  onRetry,
  loadingRows,
  isPending,
  fetchStatus,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  onRetry?: () => void;
  /** How many skeleton rows to show while loading. Defaults to 4. */
  loadingRows?: number;
  isPending?: boolean;
  fetchStatus?: "fetching" | "paused" | "idle";
  children: React.ReactNode;
}) {
  switch (queryPhase({ isLoading, error, isPending, fetchStatus })) {
    case "loading":
      return <LoadingState rows={loadingRows} />;
    case "error":
      return (
        <ErrorState
          message={error instanceof Error ? error.message : String(error)}
          onRetry={onRetry}
        />
      );
    case "unavailable":
      return <UnavailableState onRetry={onRetry} />;
    default:
      return <>{children}</>;
  }
}

/**
 * Everything `QueryState` wants out of a react-query result, so no call site has to remember five
 * props — and, more to the point, so none of them can quietly go on passing only two.
 *
 * ```tsx
 * <QueryState {...stateOf(query)}>…</QueryState>
 * ```
 */
export const stateOf = (query: {
  isLoading: boolean;
  error: unknown;
  refetch?: () => unknown;
  isPending?: boolean;
  fetchStatus?: "fetching" | "paused" | "idle";
}) => ({
  isLoading: query.isLoading,
  error: query.error,
  onRetry: query.refetch ? () => void query.refetch?.() : undefined,
  isPending: query.isPending,
  fetchStatus: query.fetchStatus,
});
