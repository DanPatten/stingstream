import type { Api, Jellyfin } from "@jellyfin/sdk";
import axios from "axios";

/**
 * Creates a Jellyfin `Api` on an axios instance of its own.
 *
 * That one detail is the whole reason this function exists rather than a bare
 * `jellyfin.createApi(...)` call. `createApi` defaults to the **global** axios
 * instance, so anything attached to `api.axiosInstance` used to watch every
 * bare `axios` call in the app rather than the Jellyfin ones. Two things came
 * out of that, both real: a 401 from a Streamystats server reached the
 * session-expiry interceptor and signed the user out of Jellyfin, and
 * interceptors piled up again on every login and server switch.
 *
 * It used to also carry proxy auth headers per request (Cloudflare Access,
 * Pangolin and friends). That feature is gone — a StingStream node is reached
 * through its own gateway, and the one thing the headers bought was reaching a
 * server behind somebody else's access proxy, which a tunnel does better
 * (`docs/SIDEDOOR.md`).
 */
export function createServerApi(
  jellyfin: Jellyfin,
  serverUrl: string,
  accessToken?: string,
): Api {
  return jellyfin.createApi(serverUrl, accessToken, axios.create());
}
