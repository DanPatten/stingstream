import { useNodeContext } from "@/hooks/useNodeContext";
import { useNetworkStatus } from "@/providers/NetworkStatusProvider";
import { AuthCard } from "./AuthCard";
import { ServerStarting } from "./ServerStarting";

/**
 * "Starting your server", full screen, for somebody who is already signed in.
 *
 * The sign-in screen has shown this card for a cold node since the auto-connect rewrite. A
 * returning browser never saw it: its stored session skipped straight to Home, whose connection
 * check read the gateway's 503 as "Server unreachable" and offered Retry for a server that was
 * simply still coming up. This is the same card on the same surface, driven by
 * `NetworkStatusProvider`, which keeps polling and lets the app through the moment the server is
 * ready. Stalled, it becomes the same stalled card with Try again.
 */
export const ServerStartingScreen: React.FC = () => {
  const { serverState, retryCheck } = useNetworkStatus();
  const nodeContext = useNodeContext();

  return (
    <AuthCard>
      <ServerStarting
        serverName={nodeContext?.serverName ?? null}
        addresses={nodeContext?.addresses ?? []}
        exhausted={serverState === "stalled"}
        onRetry={() => {
          void retryCheck();
        }}
      />
    </AuthCard>
  );
};

/** Whether the signed-in app should show `ServerStartingScreen` rather than its own content. */
export function showsServerStarting(
  serverState: ReturnType<typeof useNetworkStatus>["serverState"],
): boolean {
  return serverState === "starting" || serverState === "stalled";
}
