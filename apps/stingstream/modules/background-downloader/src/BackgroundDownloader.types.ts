import type { EventSubscription } from "expo-modules-core";

export interface DownloadProgressEvent {
  taskId: number;
  bytesWritten: number;
  totalBytes: number;
  progress: number;
  /** Jellyfin item id, echoed from the metadata passed at enqueue time (absent without metadata). */
  itemId?: string;
}

export interface DownloadCompleteEvent {
  taskId: number;
  filePath: string;
  url: string;
  /** Jellyfin item id, echoed from the metadata passed at enqueue time (absent without metadata). */
  itemId?: string;
}

export interface DownloadErrorEvent {
  taskId: number;
  error: string;
  /** Jellyfin item id, echoed from the metadata passed at enqueue time (absent without metadata). */
  itemId?: string;
}

export interface DownloadStartedEvent {
  taskId: number;
  url: string;
  /** Jellyfin item id, echoed from the metadata passed at enqueue time (absent without metadata). */
  itemId?: string;
}

export interface ActiveDownload {
  /** Native task id; `-1` for queued entries, which have no task yet. */
  taskId: number;
  url: string;
  /** Jellyfin item id, echoed from the metadata passed at enqueue time (absent without metadata). */
  itemId?: string;
  destinationPath?: string;
  /** `running` for the transfer in flight, `queued` for entries waiting behind it. */
  state?: "running" | "queued";
}

/**
 * Everything the iOS Live Activity needs in order to render without a JS runtime.
 *
 * The activity is driven from the native URLSession delegate, which keeps working when iOS has torn
 * down the JS runtime — so nothing here can be resolved lazily later. In particular `labels` carries
 * pre-translated strings, keeping i18n in `translations/*.json` instead of duplicating it in Swift.
 *
 * iOS only; ignored on Android.
 */
export interface DownloadActivityMetadata {
  itemId: string;
  title: string;
  subtitle: string;
  /** File name inside the directory returned by `getLiveActivityDirectory()`. */
  posterFileName?: string;
  /** Fallback total used when the server sends no Content-Length (transcoded downloads). */
  estimatedTotalBytes?: number;
  /** Localized labels keyed by state: `downloading` | `completed` | `failed` | `queued`. */
  labels: Record<string, string>;
}

/**
 * Per-download transport settings. Both platforms accept it; both clamp it to 1..1800 seconds.
 */
export interface DownloadOptions {
  /**
   * How long a download may go without receiving a byte before it is called dead.
   *
   * The default (60s on Android, 300s on iOS) is right for the transfer StingStream downloads by
   * default -- the original file, straight off a peer's disk over the mesh, which starts sending
   * within a round trip. It is badly wrong for a transcode, which sends nothing at all while the
   * home node starts ffmpeg and seeks: that is how M5's 4K download died at exactly sixty seconds
   * (`docs/APP-RELEASE.md` §11). Pass a long one whenever the URL is a transcode.
   */
  readTimeoutSeconds?: number;
}

export interface BackgroundDownloaderModuleType {
  startDownload(
    url: string,
    destinationPath?: string,
    metadata?: DownloadActivityMetadata,
    headers?: Record<string, string>,
    options?: DownloadOptions,
  ): Promise<number>;
  enqueueDownload(
    url: string,
    destinationPath?: string,
    metadata?: DownloadActivityMetadata,
    headers?: Record<string, string>,
    options?: DownloadOptions,
  ): Promise<number>;
  cancelDownload(taskId: number): void;
  cancelQueuedDownload(url: string): void;
  cancelAllDownloads(): void;
  getActiveDownloads(): Promise<ActiveDownload[]>;
  /** iOS only — absent from the Android module. */
  setLiveActivityEnabled?(enabled: boolean): void;
  /** iOS only — absent from the Android module. */
  getLiveActivityDirectory?(): string | null;
  addListener(
    eventName: string,
    listener: (event: any) => void,
  ): EventSubscription;
}
