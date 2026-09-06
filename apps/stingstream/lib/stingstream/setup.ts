import { t } from "i18next";

/**
 * First run: claiming a fresh node's one account.
 *
 * `StingStream.Core` exposes two anonymous routes for this (`Controllers/SetupController.cs`), and
 * the gateway refuses `setup/admin` from anywhere but the machine the node runs on. They are the
 * only endpoints the app calls before it has a session, so they go through plain `fetch` against
 * the node origin rather than the generated client, which is keyed on an authenticated
 * `apiAtom` — same reasoning as `lib/stingstream/status.ts` and `/healthz`.
 */

/** Where the two routes live under a node's origin. */
const SETUP_STATE_PATH = "/stingstream/api/v1/setup/state";
const SETUP_ADMIN_PATH = "/stingstream/api/v1/setup/admin";

/** Core's own rules, mirrored so a typo is caught before a round trip. */
export const USERNAME_MAX_LENGTH = 32;
export const PASSWORD_MIN_LENGTH = 8;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** How long one setup request gets before it is called unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How many times to ask for the setup state, and how long to wait between tries.
 *
 * The one call that happens while a node is still coming up: the gateway is listening (it served
 * this very page) seconds before Core is, so a fresh node answers 503 for a moment. Retrying is
 * the difference between the golden first-run screen and a sign-in card for an account that does
 * not exist yet.
 */
const STATE_ATTEMPTS = 4;
const STATE_RETRY_DELAY_MS = 500;

/**
 * How hard to try when a brand-new node answers `setup/admin` with 409 "still starting up".
 *
 * Core creates the bootstrap account at the front of its wiring pass, so a submit that beats it
 * gets a 409 meaning "not yet", not "already claimed" (WP-CORE). Falling through to the sign-in
 * card there would be the worst possible answer: a password prompt for an account that does not
 * exist. Bounded, so a node that is genuinely stuck still says so rather than spinning.
 */
const ADMIN_ATTEMPTS = 3;
const ADMIN_RETRY_DELAY_MS = 2_000;

/** Whether this node still needs its first account, and whether we may create it here. */
export interface SetupState {
  /** True while nobody has created an account on this node yet. */
  pending: boolean;
  /** True when this request came from the machine the node runs on. */
  loopback: boolean;
}

/**
 * Why a setup request was refused, in terms the screen can act on rather than an HTTP status.
 *
 * - `invalid` — the name or the password is not usable; the message says which.
 * - `starting` — the node has not finished wiring itself up. Worth trying again in a moment, and
 *   the one refusal the first-run screen must *not* treat as final.
 * - `not_pending` — somebody already claimed this node. The sign-in card is the right screen.
 * - `not_local` — the request did not come from the node's own machine.
 * - `unreachable` — nothing answered.
 * - `server` — it answered with something nobody planned for.
 */
export type SetupErrorKind =
  | "invalid"
  | "starting"
  | "not_pending"
  | "not_local"
  | "unreachable"
  | "server";

/**
 * A refused setup request. `message` is already translated and already fit to show — the screens
 * render it in a `FormError`, because `Alert.alert` draws nothing at all on react-native-web and a
 * first-run screen that fails silently is a dead end with no way out.
 */
export class SetupRequestError extends Error {
  readonly kind: SetupErrorKind;

  constructor(kind: SetupErrorKind, message: string) {
    super(message);
    this.name = "SetupRequestError";
    this.kind = kind;
  }
}

/** Per-field complaints, keyed by field. An empty object means the form is good to send. */
export interface SetupFormErrors {
  username?: string;
  password?: string;
  confirm?: string;
}

export interface SetupFormValues {
  username: string;
  password: string;
  confirm: string;
}

/**
 * The same rules Core enforces, applied while the user types.
 *
 * Client-side validation here is a courtesy, not a gate: `createAdmin` still surfaces whatever the
 * server says, because the server is the one that decides.
 */
export function validateSetupForm(values: SetupFormValues): SetupFormErrors {
  const errors: SetupFormErrors = {};
  const username = values.username.trim();

  if (username.length === 0) {
    errors.username = t("setup.username_required");
  } else if (username.length > USERNAME_MAX_LENGTH) {
    errors.username = t("setup.username_too_long", {
      max: USERNAME_MAX_LENGTH,
    });
  } else if (!USERNAME_PATTERN.test(username)) {
    errors.username = t("setup.username_invalid");
  }

  if (values.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = t("setup.password_too_short", {
      min: PASSWORD_MIN_LENGTH,
    });
  }

  // Only worth saying once the password itself is usable — two complaints about one mistake read
  // as two mistakes.
  if (!errors.password && values.confirm !== values.password) {
    errors.confirm = t("setup.passwords_do_not_match");
  }

  return errors;
}

/** True when nothing in the form needs fixing. */
export const isSetupFormValid = (errors: SetupFormErrors): boolean =>
  Object.keys(errors).length === 0;

/** Injectable for tests; the app always uses the global. */
export type FetchLike = typeof fetch;

export interface SetupRequestOptions {
  fetch?: FetchLike;
}

export interface SetupAdminOptions extends SetupRequestOptions {
  /** Total tries at a node that says it is still starting. */
  attempts?: number;
  /** Pause between those tries. Tests pass 0. */
  retryDelayMs?: number;
}

export interface SetupStateOptions extends SetupRequestOptions {
  /** Total tries, including the first. */
  attempts?: number;
  /** Pause between tries. Tests pass 0. */
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

async function request(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<Response> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: abort.signal });
  } catch {
    throw new SetupRequestError("unreachable", t("setup.error_unreachable"));
  } finally {
    clearTimeout(timeout);
  }
}

/** The `{Error}` sentence Core sends with a 400/409, when it sent one. */
async function refusalSentence(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { Error?: unknown };
    return typeof body?.Error === "string" && body.Error.trim().length > 0
      ? body.Error
      : null;
  } catch {
    return null;
  }
}

async function fetchSetupState(
  origin: string,
  fetchImpl: FetchLike,
): Promise<SetupState> {
  const response = await request(
    `${origin}${SETUP_STATE_PATH}`,
    { method: "GET", headers: { accept: "application/json" } },
    fetchImpl,
  );

  // A **404 means not pending**, deliberately: an older node has no `setup` routes at all, and
  // the only sane reading of "this node has never heard of first-run setup" is that its account
  // already exists. Anything else strands a working server behind a screen it cannot satisfy.
  if (response.status === 404) return { pending: false, loopback: false };

  if (!response.ok) {
    throw new SetupRequestError("server", t("setup.error_unexpected"));
  }

  let body: { Pending?: unknown; Loopback?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new SetupRequestError("server", t("setup.error_unexpected"));
  }

  return { pending: body?.Pending === true, loopback: body?.Loopback === true };
}

/**
 * Whether this node still needs its first account.
 *
 * Retries an unreachable or erroring node a few times before giving up: the gateway serves this
 * page before Core is up, so "still starting" is a normal answer on a cold node, not a failure.
 */
export async function getSetupState(
  origin: string,
  options: SetupStateOptions = {},
): Promise<SetupState> {
  const {
    fetch: fetchImpl = fetch,
    attempts = STATE_ATTEMPTS,
    retryDelayMs = STATE_RETRY_DELAY_MS,
  } = options;

  let last: unknown;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      return await fetchSetupState(origin, fetchImpl);
    } catch (error) {
      last = error;
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  throw last;
}

/** What Core hands back once the account exists — a session for it. */
export interface CreatedAdmin {
  accessToken: string | null;
  userId: string | null;
  username: string;
}

/**
 * Create the node's one account.
 *
 * The gateway 404s this route for any peer that is not on the node's own machine, which is why a
 * 404 here is `not_local` rather than "no such endpoint" — `getSetupState` is the call that has to
 * tolerate an old node, and it is reachable from everywhere.
 */
export async function createAdmin(
  origin: string,
  credentials: { username: string; password: string },
  options: SetupAdminOptions = {},
): Promise<CreatedAdmin> {
  const {
    fetch: fetchImpl = fetch,
    attempts = ADMIN_ATTEMPTS,
    retryDelayMs = ADMIN_RETRY_DELAY_MS,
  } = options;

  let last: SetupRequestError | undefined;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      return await postAdmin(origin, credentials, fetchImpl);
    } catch (error) {
      // Only "the node is still starting" is worth a second go. A refused password stays refused.
      if (!(error instanceof SetupRequestError) || error.kind !== "starting") {
        throw error;
      }
      last = error;
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  throw last;
}

/** One `POST setup/admin`, with every answer it can give mapped onto a typed error. */
async function postAdmin(
  origin: string,
  credentials: { username: string; password: string },
  fetchImpl: FetchLike,
): Promise<CreatedAdmin> {
  const response = await request(
    `${origin}${SETUP_ADMIN_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        Username: credentials.username,
        Password: credentials.password,
      }),
    },
    fetchImpl,
  );

  if (response.status === 400) {
    throw new SetupRequestError(
      "invalid",
      (await refusalSentence(response)) ?? t("setup.error_invalid"),
    );
  }
  if (response.status === 409) {
    const sentence = await refusalSentence(response);
    // A 409 means one of two opposite things, and the sentence that distinguishes them is English
    // prose from the server. So ask the endpoint that answers in booleans instead: still pending
    // means the node had not finished wiring itself up; no longer pending means somebody claimed
    // it between this screen loading and this submit.
    const state = await getSetupState(origin, {
      fetch: fetchImpl,
      attempts: 1,
    }).catch(() => null);
    if (state?.pending !== false) {
      throw new SetupRequestError(
        "starting",
        sentence ?? t("setup.error_starting"),
      );
    }
    throw new SetupRequestError(
      "not_pending",
      t("setup.error_already_claimed"),
    );
  }
  if (response.status === 404) {
    throw new SetupRequestError("not_local", t("setup.error_not_local"));
  }
  if (!response.ok) {
    throw new SetupRequestError("server", t("setup.error_unexpected"));
  }

  let body: {
    AccessToken?: unknown;
    User?: { Id?: unknown; Name?: unknown } | null;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // The account was created — a body we cannot read is not a reason to say it failed. The
    // caller signs in with the credentials it already has.
    return { accessToken: null, userId: null, username: credentials.username };
  }

  return {
    accessToken:
      typeof body?.AccessToken === "string" ? body.AccessToken : null,
    userId: typeof body?.User?.Id === "string" ? body.User.Id : null,
    username:
      typeof body?.User?.Name === "string"
        ? body.User.Name
        : credentials.username,
  };
}
