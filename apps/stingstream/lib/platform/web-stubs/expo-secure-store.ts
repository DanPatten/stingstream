/**
 * `expo-secure-store` on web.
 *
 * The package ships an *empty object* as its web native module
 * (`build/ExpoSecureStore.web.js` is literally `export default {}`), while its
 * JS surface calls straight through to it. So every `getItemAsync` in a browser
 * throws `ExpoSecureStore.getValueWithKeyAsync is not a function` rather than
 * returning nothing — which surfaced as a warning on every single screen:
 *
 *   Background user validation failed: n.default.getValueWithKeyAsync is not a function
 *
 * (`providers/JellyfinProvider.tsx` was right to warn — the call really did
 * fail. The bug was underneath it.)
 *
 * This stub answers the way "no secure storage here" should answer: reads
 * resolve to `null`, writes and deletes resolve without doing anything, and
 * `isAvailableAsync()` says false so a caller that asks gets an honest answer.
 *
 * **Deliberately not backed by `localStorage`.** The values this module holds
 * are session tokens and saved-account credentials; putting them in storage any
 * script on the origin can read would make the app *look* like it kept them
 * safely. A browser has no keychain, so the honest behaviour is to keep
 * nothing. The practical effect — saved accounts and "keep me signed in" do not
 * persist on web — is what already happened, only without the exception.
 *
 * Same mechanism and the same reasoning as the other entries in
 * `metro.config.js`'s `webModuleStubs`; see `docs/M2-web-spike.md`.
 */

export type SecureStoreOptions = Record<string, unknown>;

export const AFTER_FIRST_UNLOCK = "afterFirstUnlock";
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY =
  "afterFirstUnlockThisDeviceOnly";
export const ALWAYS = "always";
export const ALWAYS_THIS_DEVICE_ONLY = "alwaysThisDeviceOnly";
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY =
  "whenPasscodeSetThisDeviceOnly";
export const WHEN_UNLOCKED = "whenUnlocked";
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "whenUnlockedThisDeviceOnly";

export async function isAvailableAsync(): Promise<boolean> {
  return false;
}

export async function getItemAsync(
  _key: string,
  _options?: SecureStoreOptions,
): Promise<string | null> {
  return null;
}

export async function setItemAsync(
  _key: string,
  _value: string,
  _options?: SecureStoreOptions,
): Promise<void> {}

export async function deleteItemAsync(
  _key: string,
  _options?: SecureStoreOptions,
): Promise<void> {}

/** The synchronous trio, added in SDK 51 and used by the custom-header store. */
export function getItem(
  _key: string,
  _options?: SecureStoreOptions,
): string | null {
  return null;
}

export function setItem(
  _key: string,
  _value: string,
  _options?: SecureStoreOptions,
): void {}

export function canUseBiometricAuthentication(): boolean {
  return false;
}
