/**
 * Web stub for the local `background-downloader` Expo module (StingStream M2).
 *
 * The real module is a `requireNativeModule("BackgroundDownloader")` call at
 * module scope, backed by URLSession (iOS) / DownloadManager (Android). On web
 * that call throws during import and takes the whole bundle down before React
 * renders, so Metro picks this `.web` sibling instead (standard Expo platform
 * extension — native resolution is untouched).
 *
 * Offline downloads are "not available on web": nothing is enqueued, the active
 * list is always empty, and listeners never fire. Callers in
 * `providers/Downloads/**` treat an empty queue as "nothing downloading", so the
 * Downloads screen renders empty rather than crashing.
 */

import type { EventSubscription } from "expo-modules-core";
import type {
  ActiveDownload,
  BackgroundDownloaderModuleType,
  DownloadActivityMetadata,
} from "./BackgroundDownloader.types";

const NOT_SUPPORTED = "Background downloads are not available on web.";

const noSubscription: EventSubscription = { remove: () => {} };

const BackgroundDownloaderModule: BackgroundDownloaderModuleType = {
  startDownload: async (
    _url: string,
    _destinationPath?: string,
    _metadata?: DownloadActivityMetadata,
    _headers?: Record<string, string>,
  ): Promise<number> => {
    throw new Error(NOT_SUPPORTED);
  },
  enqueueDownload: async (
    _url: string,
    _destinationPath?: string,
    _metadata?: DownloadActivityMetadata,
    _headers?: Record<string, string>,
  ): Promise<number> => {
    throw new Error(NOT_SUPPORTED);
  },
  cancelDownload: (_taskId: number) => {},
  cancelQueuedDownload: (_url: string) => {},
  cancelAllDownloads: () => {},
  getActiveDownloads: async (): Promise<ActiveDownload[]> => [],
  setLiveActivityEnabled: (_enabled: boolean) => {},
  getLiveActivityDirectory: () => null,
  addListener: (
    _eventName: string,
    _listener: (event: any) => void,
  ): EventSubscription => noSubscription,
};

export default BackgroundDownloaderModule;
