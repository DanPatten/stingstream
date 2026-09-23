import type { Api } from "@jellyfin/sdk";
import type {
  PlaybackProgressInfo,
  PlaybackStopInfo,
} from "@jellyfin/sdk/lib/generated-client/models";

/** The two reports worth sending while a page is going away. */
export type KeepaliveReport =
  | { kind: "progress"; info: PlaybackProgressInfo }
  | { kind: "stopped"; info: PlaybackStopInfo };

const PATHS: Record<KeepaliveReport["kind"], string> = {
  progress: "/Sessions/Playing/Progress",
  stopped: "/Sessions/Playing/Stopped",
};

type Fetch = (input: string, init: RequestInit) => Promise<unknown>;

/**
 * A playback report that survives the tab closing.
 *
 * Closing a browser tab mid-movie used to send nothing: the SDK's axios request is cancelled with
 * the page, so the server kept whatever position the last 10-second heartbeat carried and closed
 * the session five minutes later. `fetch` with `keepalive` is the one request a browser promises
 * to finish after `pagehide`. `navigator.sendBeacon` would be the usual answer, but it cannot
 * carry the Authorization header the server needs.
 *
 * Fire and forget: nothing is left to handle an answer.
 */
export function sendKeepaliveReport(
  api: Pick<Api, "basePath" | "authorizationHeader">,
  report: KeepaliveReport,
  fetchImpl: Fetch | undefined = globalThis.fetch as Fetch | undefined,
): void {
  if (!fetchImpl) return;
  try {
    void Promise.resolve(
      fetchImpl(`${api.basePath}${PATHS[report.kind]}`, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          Authorization: api.authorizationHeader,
        },
        body: JSON.stringify(report.info),
      }),
    ).catch(() => undefined);
  } catch {
    // A browser that refuses the request outright (a keepalive body over its quota): nothing to do.
  }
}
