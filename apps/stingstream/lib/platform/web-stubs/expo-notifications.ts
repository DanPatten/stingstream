/**
 * Web stub for `expo-notifications` (StingStream M2 web target).
 *
 * The app already loads the module lazily, but the guard is `Platform.isTV`,
 * which is false on web — so `app/_layout.tsx` gets the real module and its
 * first call, `Notifications.getLastNotificationResponseAsync()`, throws
 * `UnavailabilityError` *synchronously* inside a `useEffect`. That aborts the
 * rest of that effect (deep-link handling, badge sync, listener registration),
 * so the failure is not merely noisy.
 *
 * expo-notifications does have partial web support (web push via VAPID), but
 * nothing in StingStream's flow works without a service worker and a push
 * subscription, and local scheduled notifications for download progress are
 * meaningless in a browser tab. So notifications are "not available on web":
 * permissions report `denied`, listeners are inert, and every command resolves.
 *
 * Metro substitutes this module for `platform === "web"` only — see
 * `webModuleStubs` in `metro.config.js`.
 */

export enum AndroidImportance {
  UNKNOWN = 0,
  UNSPECIFIED = 1,
  NONE = 2,
  MIN = 3,
  LOW = 4,
  DEFAULT = 5,
  HIGH = 6,
  MAX = 7,
}

export enum AndroidNotificationPriority {
  MIN = "min",
  LOW = "low",
  DEFAULT = "default",
  HIGH = "high",
  MAX = "max",
}

export enum AndroidNotificationVisibility {
  UNKNOWN = 0,
  PUBLIC = 1,
  PRIVATE = 2,
  SECRET = 3,
}

export enum PermissionStatus {
  GRANTED = "granted",
  UNDETERMINED = "undetermined",
  DENIED = "denied",
}

const deniedPermissions = {
  status: PermissionStatus.DENIED,
  granted: false,
  canAskAgain: false,
  expires: "never" as const,
};

const noSubscription = { remove: () => {} };

export const setNotificationHandler = (_handler: unknown): void => {};

export const getLastNotificationResponseAsync = async (): Promise<null> => null;

export const getPermissionsAsync = async () => deniedPermissions;
export const requestPermissionsAsync = async () => deniedPermissions;

export const setBadgeCountAsync = async (_count: number): Promise<boolean> =>
  false;
export const getBadgeCountAsync = async (): Promise<number> => 0;

export const setNotificationChannelAsync = async (
  _channelId: string,
  _channel: unknown,
): Promise<null> => null;
export const deleteNotificationChannelAsync = async (
  _channelId: string,
): Promise<void> => {};

export const scheduleNotificationAsync = async (
  _request: unknown,
): Promise<string> => "";
export const cancelScheduledNotificationAsync = async (
  _identifier: string,
): Promise<void> => {};
export const cancelAllScheduledNotificationsAsync =
  async (): Promise<void> => {};
export const dismissNotificationAsync = async (
  _identifier: string,
): Promise<void> => {};
export const dismissAllNotificationsAsync = async (): Promise<void> => {};
export const getPresentedNotificationsAsync = async (): Promise<
  unknown[]
> => [];

export const getExpoPushTokenAsync = async (
  _options?: unknown,
): Promise<never> => {
  throw new Error("Push notifications are not available on web.");
};
export const getDevicePushTokenAsync = async (): Promise<never> => {
  throw new Error("Push notifications are not available on web.");
};

export const addNotificationReceivedListener = (
  _listener: (...args: any[]) => void,
) => noSubscription;
export const addNotificationResponseReceivedListener = (
  _listener: (...args: any[]) => void,
) => noSubscription;
export const addNotificationsDroppedListener = (
  _listener: (...args: any[]) => void,
) => noSubscription;
export const removeNotificationSubscription = (_subscription: any): void => {};

export const useLastNotificationResponse = (): null => null;

/** Some call sites reach for `Notifications.types`; keep the property present. */
export const types = {};

export default {
  AndroidImportance,
  AndroidNotificationPriority,
  AndroidNotificationVisibility,
  PermissionStatus,
  setNotificationHandler,
  getLastNotificationResponseAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  setBadgeCountAsync,
  getBadgeCountAsync,
  setNotificationChannelAsync,
  deleteNotificationChannelAsync,
  scheduleNotificationAsync,
  cancelScheduledNotificationAsync,
  cancelAllScheduledNotificationsAsync,
  dismissNotificationAsync,
  dismissAllNotificationsAsync,
  getPresentedNotificationsAsync,
  getExpoPushTokenAsync,
  getDevicePushTokenAsync,
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  addNotificationsDroppedListener,
  removeNotificationSubscription,
  useLastNotificationResponse,
  types,
};
