import * as Crypto from "expo-crypto";
import { storage } from "./mmkv";
import { formatUuidV4 } from "./uuid";

/**
 * A UUID, on every origin this app is ever served from.
 *
 * `Crypto.randomUUID()` is `crypto.randomUUID()` on web, and browsers expose that **only in a
 * secure context** — https, or `localhost`. A node serves its bundle over plain HTTP on a LAN
 * address as a matter of course, and there `crypto` exists while `crypto.randomUUID` does not, so
 * this threw inside `JellyfinProvider`'s `useState` initialiser and took the entire app down with
 * "Something went wrong" before a single screen rendered. Verified against a real node at
 * `http://192.168.0.16:8803` on 2026-09-06; `http://127.0.0.1:8803` was fine, which is exactly why
 * it had gone unnoticed.
 *
 * `crypto.getRandomValues` has no such restriction, so the fallback is still real randomness.
 */
const randomUuid = (): string => {
  try {
    return Crypto.randomUUID();
  } catch {
    // Fall through: an insecure origin, or a runtime without the newer API.
  }
  try {
    return formatUuidV4(Crypto.getRandomValues(new Uint8Array(16)));
  } catch {
    // Nothing cryptographic is reachable at all. A device id is a stable label, not a secret —
    // a weak one is better than an app that will not start.
    return formatUuidV4(
      Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
    );
  }
};

export const getOrSetDeviceId = () => {
  const existing = storage.getString("deviceId");
  if (existing) {
    return existing;
  }

  const deviceId = randomUuid();
  storage.set("deviceId", deviceId);
  return deviceId;
};

export const getDeviceId = () => {
  const deviceId = storage.getString("deviceId");

  return deviceId || null;
};
