import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { Loader } from "@/components/Loader";

export function LoadingState() {
  return (
    <View className='items-center justify-center py-16'>
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
  return (
    <View className='items-center justify-center py-16 px-6'>
      <Text className='text-red-500 text-center font-semibold'>
        Something went wrong
      </Text>
      <Text className='text-[#9899A1] text-xs text-center mt-1'>{message}</Text>
      {onRetry && (
        <Text className='text-[#0584FE] mt-3' onPress={onRetry}>
          Tap to retry
        </Text>
      )}
    </View>
  );
}

export function EmptyState({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <View className='items-center justify-center py-16 px-6'>
      <Text className='text-white font-semibold text-center'>{title}</Text>
      {detail && (
        <Text className='text-[#9899A1] text-xs text-center mt-1'>
          {detail}
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
