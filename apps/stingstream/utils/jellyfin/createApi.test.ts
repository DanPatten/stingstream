import { describe, expect, test } from "bun:test";
import { Jellyfin } from "@jellyfin/sdk";
import axios from "axios";
import { createServerApi } from "./createApi";

const SERVER = "https://jellyfin.example";

/**
 * The real SDK, not a double: the argument this wrapper cares about is the
 * third one of `Jellyfin.createApi(basePath, accessToken?, axiosInstance?)`,
 * and a fake that hard-codes that position would keep passing after an SDK bump
 * moved it — while `Api` quietly fell back to `axiosInstance = globalAxios` and
 * put every interceptor back on the shared instance.
 */
const jellyfin = () =>
  new Jellyfin({
    clientInfo: { name: "stingstream-tests", version: "0.0.0" },
    deviceInfo: { name: "test-device", id: "device-1" },
  });

describe("createServerApi", () => {
  /**
   * The whole reason this wrapper exists. On the global instance, a 401 from an
   * unrelated server reached the session-expiry interceptor and signed the user
   * out of Jellyfin, and interceptors piled up on every login and server switch.
   */
  test("gives each Api an axios instance of its own, never the global one", () => {
    const one = createServerApi(jellyfin(), SERVER);
    const two = createServerApi(jellyfin(), SERVER);

    expect(one.axiosInstance).not.toBe(axios);
    expect(two.axiosInstance).not.toBe(axios);
    expect(one.axiosInstance).not.toBe(two.axiosInstance);
  });

  test("passes the server and the token through to the SDK", () => {
    const api = createServerApi(jellyfin(), SERVER, "token-1");

    expect(api.basePath).toBe(SERVER);
    expect(api.accessToken).toBe("token-1");
  });
});
