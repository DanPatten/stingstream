# Three API clients, and session expiry only ever covered one

This app talks to a server through **three** different transports. They are easy to mistake for one
because they all carry the same Jellyfin token, and because the thing that handles an expired
session is named as though it were global when it is not.

| Client | Transport | Where |
| --- | --- | --- |
| Jellyfin SDK | axios | `utils/jellyfin/createApi.ts`, every `getXApi()` call |
| Hand-rolled node clients | raw `fetch` | `lib/stingstream/*Api.ts`, errors through `meshApi.readError` |
| Generated node client | `openapi-fetch` | `@stingstream/api-client`, errors through `lib/stingstream/unwrap.ts` |

**The session-expiry teardown is an axios response interceptor** installed in `JellyfinProvider`
on `api.axiosInstance`. It therefore sees Jellyfin's calls and nothing else. For a long time a
revoked token produced two completely different behaviours in one session: Jellyfin's screens
logged out cleanly, while every node-backed screen sat there failing forever against a token the
app still believed in, because its 401s never reached the interceptor and the dead token stayed in
MMKV.

It was worse than a missing logout. `meshApi.readError` collapsed 401 and 403 into one sentence,
"this needs an administrator account on your server", so an expired session was reported as a
permissions problem on endpoints that never required an administrator. Dan hit it on
`GET /requests/discover`, which carries only the controller's class-level `[Authorize]`.

**If you add a fourth way to reach the server, wire it to `utils/sessionExpiry.ts`.**
`reportSessionExpired()` reaches the provider's teardown from plain non-React code;
`onSessionExpired()` registers the handler, inside the same effect as the axios interceptor and
behind the same `api?.accessToken` guard.

Two constraints that are load-bearing rather than tidy:

- **`utils/sessionExpiry.ts` imports nothing.** The `lib/stingstream/*Api.ts` files are split from
  their hook files so `bun:test` can load them without reaching `providers/JellyfinProvider` and,
  through it, `codegenNativeComponent`, which cannot load in a test process.
- **Do not shortcut it with `store.set(userAtom, null)`.** That flips the redirect while leaving the
  dead token in MMKV and the query cache warm, so the next launch re-hydrates straight back into the
  broken state. Only `clearSessionState` does the whole job.

Related: 401 and 403 are opposite answers and must never share a sentence. 403 is not reliably about
being an administrator either, since Jellyfin's `DefaultAuthorizationHandler` answers 403 to a
remote caller whose account has remote access turned off and to one inside a blocked parental
schedule, both with a valid session.
