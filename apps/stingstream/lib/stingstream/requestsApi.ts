import { authHeaders, both, field, readError } from "./meshApi";

/**
 * The plain-fetch half of `lib/stingstream/requests.ts` — `/stingstream/api/v1/requests/*`,
 * `StingStream.Core`'s `RequestsController` (M6).
 *
 * Split from the hooks for the same reason `meshApi.ts` is split from `mesh.ts`: nothing here
 * imports React or `providers/JellyfinProvider`, so `bun:test` can load it directly. The
 * provider's import graph reaches a native `codegenNativeComponent` a few layers down and cannot
 * be loaded in a test process, which means any logic worth asserting has to live on this side of
 * the line. All of the shaping does.
 *
 * ## Casing
 *
 * Core answers **PascalCase** (`docs/APP-MESH.md` §6): it is hosted inside Jellyfin, whose global
 * `JsonSerializerOptions` are PascalCase, and `StingStreamControllerBase` overrides the
 * `[Produces]` media types without touching the naming policy. Every reader below accepts both
 * spellings through `field(raw, ...both("x"))`, so this file keeps working whichever way that
 * eventually settles.
 *
 * Nulls are omitted from the wire, so every optional field may simply be absent rather than null.
 *
 * Hand-written rather than generated, for now: `packages/api-client`'s snapshot of the OpenAPI
 * document predates `RequestsController`, and regenerating it needs a live node.
 */

/** The states a request moves through. Mirrors `RequestStates` in Core. */
export type RequestState =
  | "pending"
  | "approved"
  | "fulfilling"
  | "available"
  | "declined"
  | "failed";

/** Who may request without asking. Mirrors `AutoApprove` in Core. */
export type AutoApproveMode = "everyone" | "trusted" | "admins_only";

/** One member request, as `RequestsController` shapes it. */
export interface MemberRequest {
  id: string;
  group: string;
  /** `movie` or `series`. */
  kind: "movie" | "series";
  /** The film's item key, or the prefix a series' episodes share. */
  itemKey: string;
  /** `tmdb` or `tvdb`. */
  provider: string;
  providerId: number;
  title: string;
  year?: number | null;
  posterUrl?: string | null;
  /** Season numbers wanted. Empty means every season. */
  seasons: number[];
  state: RequestState;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  decidedBy?: string | null;
  decidedByName?: string | null;
  decidedAt?: string | null;
  /** The node that claimed it, once one has. */
  fulfillingNode?: string | null;
  fulfillingNodeName?: string | null;
  /** A sentence a person can read: why it is where it is. */
  note: string;
  /** False for a request this node heard about over gossip rather than made. */
  mine: boolean;
  updatedAt: string;
}

/** One thing that happened to a request. */
export interface RequestEvent {
  id: number;
  requestId: string;
  state: string;
  actor: string;
  note: string;
  at: string;
}

/** A request with its trail, from `GET /requests/{id}`. */
export interface RequestDetail {
  request: MemberRequest;
  events: RequestEvent[];
}

/** The group's request policy. */
export interface RequestPolicy {
  group: string;
  autoApprove: AutoApproveMode;
  /** Requests per member per rolling week. Zero means no limit. */
  weeklyQuota: number;
  /** Ignore a group copy shorter than this many pixels. Zero means any copy will do. */
  minimumHeight: number;
  updatedAt: string;
}

/** One member, as the policy screen edits them. */
export interface RequestUser {
  userId: string;
  userName: string;
  isAdministrator: boolean;
  trusted: boolean;
  /** Their own quota, or zero to use the group's. */
  weeklyQuota: number;
  requestsThisWeek: number;
}

/** Badge counts, so a tab bar does not have to fetch every list to draw a dot. */
export interface RequestCounts {
  pendingApproval: number;
  mineOpen: number;
  unreadNotifications: number;
  canApprove: boolean;
}

/** One search result, with what the group already holds attached. */
export interface RequestSearchResult {
  kind: "movie" | "series";
  title: string;
  year?: number | null;
  overview?: string | null;
  posterUrl?: string | null;
  tmdbId: number;
  tvdbId: number;
  itemKey: string;
  /** True when a member of the group already holds it at an acceptable quality. */
  availableInGroup: boolean;
  holders: string[];
  /** The state of an existing request for the same title, when there is one. */
  requestState?: RequestState | null;
  requestId?: string | null;
}

/** One in-app notification. */
export interface RequestNotification {
  id: number;
  userId: string;
  kind: string;
  title: string;
  body: string;
  requestId?: string | null;
  read: boolean;
  createdAt: string;
}

/** What is being asked for. */
export interface CreateRequestInput {
  tmdbId?: number;
  tvdbId?: number;
  /** Seasons wanted. Omit or leave empty for all of them. */
  seasons?: number[];
  group?: string;
  title?: string;
  year?: number | null;
  posterUrl?: string | null;
}

// --- shaping ------------------------------------------------------------------------------------

export const toRequest = (raw: unknown): MemberRequest => ({
  id: field<string>(raw, ...both("id"), "Id") ?? "",
  group: field<string>(raw, ...both("group")) ?? "",
  kind: (field<string>(raw, ...both("kind")) ??
    "movie") as MemberRequest["kind"],
  itemKey: field<string>(raw, ...both("itemKey")) ?? "",
  provider: field<string>(raw, ...both("provider")) ?? "",
  providerId: field<number>(raw, ...both("providerId")) ?? 0,
  title: field<string>(raw, ...both("title")) ?? "",
  year: field<number>(raw, ...both("year")),
  posterUrl: field<string>(raw, ...both("posterUrl")),
  seasons: field<number[]>(raw, ...both("seasons")) ?? [],
  state: (field<string>(raw, ...both("state")) ?? "pending") as RequestState,
  requestedBy: field<string>(raw, ...both("requestedBy")) ?? "",
  requestedByName: field<string>(raw, ...both("requestedByName")) ?? "",
  requestedAt: field<string>(raw, ...both("requestedAt")) ?? "",
  decidedBy: field<string>(raw, ...both("decidedBy")),
  decidedByName: field<string>(raw, ...both("decidedByName")),
  decidedAt: field<string>(raw, ...both("decidedAt")),
  fulfillingNode: field<string>(raw, ...both("fulfillingNode")),
  fulfillingNodeName: field<string>(raw, ...both("fulfillingNodeName")),
  note: field<string>(raw, ...both("note")) ?? "",
  // Absent means "made here". A request adopted from another node always carries an explicit
  // false, so defaulting the other way would make every foreign request look like the user's own.
  mine: field<boolean>(raw, ...both("mine")) ?? true,
  updatedAt: field<string>(raw, ...both("updatedAt")) ?? "",
});

export const toRequestEvent = (raw: unknown): RequestEvent => ({
  id: field<number>(raw, ...both("id"), "Id") ?? 0,
  requestId: field<string>(raw, ...both("requestId")) ?? "",
  state: field<string>(raw, ...both("state")) ?? "",
  actor: field<string>(raw, ...both("actor")) ?? "",
  note: field<string>(raw, ...both("note")) ?? "",
  at: field<string>(raw, ...both("at"), "At") ?? "",
});

export const toRequestDetail = (raw: unknown): RequestDetail => ({
  request: toRequest(field<unknown>(raw, ...both("request")) ?? {}),
  events: (field<unknown[]>(raw, ...both("events")) ?? []).map(toRequestEvent),
});

export const toPolicy = (raw: unknown): RequestPolicy => ({
  group: field<string>(raw, ...both("group")) ?? "",
  autoApprove: (field<string>(raw, ...both("autoApprove")) ??
    "trusted") as AutoApproveMode,
  weeklyQuota: field<number>(raw, ...both("weeklyQuota")) ?? 0,
  minimumHeight: field<number>(raw, ...both("minimumHeight")) ?? 0,
  updatedAt: field<string>(raw, ...both("updatedAt")) ?? "",
});

export const toRequestUser = (raw: unknown): RequestUser => ({
  userId: field<string>(raw, ...both("userId")) ?? "",
  userName: field<string>(raw, ...both("userName")) ?? "",
  isAdministrator: field<boolean>(raw, ...both("isAdministrator")) ?? false,
  trusted: field<boolean>(raw, ...both("trusted")) ?? false,
  weeklyQuota: field<number>(raw, ...both("weeklyQuota")) ?? 0,
  requestsThisWeek: field<number>(raw, ...both("requestsThisWeek")) ?? 0,
});

export const toCounts = (raw: unknown): RequestCounts => ({
  pendingApproval: field<number>(raw, ...both("pendingApproval")) ?? 0,
  mineOpen: field<number>(raw, ...both("mineOpen")) ?? 0,
  unreadNotifications: field<number>(raw, ...both("unreadNotifications")) ?? 0,
  canApprove: field<boolean>(raw, ...both("canApprove")) ?? false,
});

export const toSearchResult = (raw: unknown): RequestSearchResult => ({
  kind: (field<string>(raw, ...both("kind")) ??
    "movie") as RequestSearchResult["kind"],
  title: field<string>(raw, ...both("title")) ?? "",
  year: field<number>(raw, ...both("year")),
  overview: field<string>(raw, ...both("overview")),
  posterUrl: field<string>(raw, ...both("posterUrl")),
  tmdbId: field<number>(raw, ...both("tmdbId")) ?? 0,
  tvdbId: field<number>(raw, ...both("tvdbId")) ?? 0,
  itemKey: field<string>(raw, ...both("itemKey")) ?? "",
  availableInGroup: field<boolean>(raw, ...both("availableInGroup")) ?? false,
  holders: field<string[]>(raw, ...both("holders")) ?? [],
  requestState: field<string>(raw, ...both("requestState")) as
    | RequestState
    | undefined,
  requestId: field<string>(raw, ...both("requestId")),
});

export const toNotification = (raw: unknown): RequestNotification => ({
  id: field<number>(raw, ...both("id"), "Id") ?? 0,
  userId: field<string>(raw, ...both("userId")) ?? "",
  kind: field<string>(raw, ...both("kind")) ?? "",
  title: field<string>(raw, ...both("title")) ?? "",
  body: field<string>(raw, ...both("body")) ?? "",
  requestId: field<string>(raw, ...both("requestId")),
  read: field<boolean>(raw, ...both("read")) ?? false,
  createdAt: field<string>(raw, ...both("createdAt")) ?? "",
});

// --- presentation -------------------------------------------------------------------------------

/**
 * The one-line label for a state, in the words a member would use.
 *
 * Deliberately not the state string: "fulfilling" is a word about the *system*, and the person who
 * asked for a film wants to know it is being downloaded.
 */
export const stateLabel = (state: RequestState): string => {
  switch (state) {
    case "pending":
      return "Waiting for approval";
    case "approved":
      return "Approved";
    case "fulfilling":
      return "Downloading";
    case "available":
      return "Ready to watch";
    case "declined":
      return "Declined";
    case "failed":
      return "Could not be filled";
    default:
      return state;
  }
};

/**
 * A colour role for a state, resolved against the app's theme by the caller.
 *
 * Four roles, not six: `pending` and `approved` are both "in hand, nothing to do", and grouping
 * them keeps a list of twenty requests from looking like a paint chart.
 */
export const stateTone = (
  state: RequestState,
): "waiting" | "working" | "done" | "stopped" => {
  switch (state) {
    case "pending":
    case "approved":
      return "waiting";
    case "fulfilling":
      return "working";
    case "available":
      return "done";
    default:
      return "stopped";
  }
};

/** The seasons a request names, as a person would write them: "Seasons 1, 2" or "All seasons". */
export const seasonsLabel = (seasons: number[] | undefined): string => {
  if (!seasons || seasons.length === 0) return "All seasons";
  const sorted = [...seasons].sort((a, b) => a - b);
  if (sorted.length === 1) return `Season ${sorted[0]}`;
  return `Seasons ${sorted.join(", ")}`;
};

/** Title and year the way every screen shows it. */
export const requestTitle = (request: {
  title: string;
  year?: number | null;
}): string =>
  request.year ? `${request.title} (${request.year})` : request.title;

/**
 * What the request button should say for a search result.
 *
 * The interesting answer is usually "you already have this", and finding that out only after
 * pressing Request is too late to be useful — which is the whole reason the search endpoint
 * annotates every result with the group's holdings.
 */
export const searchAction = (
  result: RequestSearchResult,
): { label: string; disabled: boolean } => {
  if (result.availableInGroup) {
    return { label: "In your library", disabled: true };
  }
  switch (result.requestState) {
    case "available":
      return { label: "In your library", disabled: true };
    case "pending":
      return { label: "Awaiting approval", disabled: true };
    case "approved":
    case "fulfilling":
      return { label: "Already requested", disabled: true };
    // A declined or failed request is not a reason to refuse a new one: the first was refused by a
    // person who may since have changed their mind, and the second failed for reasons that may
    // have gone away.
    default:
      return { label: "Request", disabled: false };
  }
};

/**
 * Whether two Jellyfin user ids name the same person.
 *
 * Jellyfin issues the same GUID in `N` format (dashless) in its auth claim — which is what Core
 * stores in `requestedBy` — and in `D` format (dashed) in some DTOs. Comparing the two as plain
 * strings would tell a member that none of their own requests are theirs, which is exactly the kind
 * of bug that looks like an empty screen rather than an error. `UsersController` on the node side
 * parses both as GUIDs for the same reason.
 */
export const sameUser = (
  a: string | undefined,
  b: string | undefined,
): boolean => {
  if (!a || !b) return false;
  return (
    a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase()
  );
};

/** The requests a member sees on My requests: theirs, in whatever order the node returned. */
export const selectMine = (
  requests: MemberRequest[] | undefined,
  userId: string | undefined,
): MemberRequest[] => {
  if (!requests) return [];
  // No signed-in id is not "show nothing": the node has already filtered to the caller's own for a
  // non-administrator, so the safe fallback is what it sent.
  if (!userId) return requests;
  return requests.filter((r) => sameUser(r.requestedBy, userId));
};

// --- calls --------------------------------------------------------------------------------------

const json = (accessToken?: string | null): Record<string, string> => ({
  ...authHeaders(accessToken),
  "Content-Type": "application/json",
});

/** Requests. `mine` is forced on for a non-administrator by Core, whatever is passed. */
export async function fetchRequests(
  apiBaseUrl: string,
  options: { mine?: boolean; state?: RequestState } = {},
  accessToken?: string | null,
): Promise<MemberRequest[]> {
  const query = new URLSearchParams();
  if (options.mine !== undefined) query.set("mine", String(options.mine));
  if (options.state) query.set("state", options.state);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const res = await fetch(`${apiBaseUrl}/requests${suffix}`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /requests");
  return ((await res.json()) as unknown[]).map(toRequest);
}

/** One request with its trail. */
export async function fetchRequest(
  apiBaseUrl: string,
  id: string,
  accessToken?: string | null,
): Promise<RequestDetail> {
  const res = await fetch(`${apiBaseUrl}/requests/${encodeURIComponent(id)}`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, `GET /requests/${id}`);
  return toRequestDetail(await res.json());
}

/** Badge counts. */
export async function fetchRequestCounts(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<RequestCounts> {
  const res = await fetch(`${apiBaseUrl}/requests/counts`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /requests/counts");
  return toCounts(await res.json());
}

/** Search TMDB and TVDB through the node's own arrs, annotated with the group's holdings. */
export async function searchRequestable(
  apiBaseUrl: string,
  term: string,
  kind: "movie" | "series" | undefined,
  accessToken?: string | null,
): Promise<RequestSearchResult[]> {
  const query = new URLSearchParams({ q: term });
  if (kind) query.set("kind", kind);
  const res = await fetch(`${apiBaseUrl}/requests/search?${query.toString()}`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /requests/search");
  return ((await res.json()) as unknown[]).map(toSearchResult);
}

/** Ask for something. */
export async function createRequest(
  apiBaseUrl: string,
  input: CreateRequestInput,
  accessToken?: string | null,
): Promise<MemberRequest> {
  const res = await fetch(`${apiBaseUrl}/requests`, {
    method: "POST",
    headers: json(accessToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res, "POST /requests");
  return toRequest(await res.json());
}

/** Approve, decline or retry. */
export async function decideRequest(
  apiBaseUrl: string,
  id: string,
  decision: "approve" | "decline" | "retry",
  reason: string | undefined,
  accessToken?: string | null,
): Promise<MemberRequest> {
  const res = await fetch(
    `${apiBaseUrl}/requests/${encodeURIComponent(id)}/${decision}`,
    {
      method: "POST",
      headers: json(accessToken),
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
  if (!res.ok) throw await readError(res, `POST /requests/${id}/${decision}`);
  return toRequest(await res.json());
}

/** Withdraw a request. */
export async function deleteRequest(
  apiBaseUrl: string,
  id: string,
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/requests/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, `DELETE /requests/${id}`);
}

/** The group's policy. Readable by every member; writable only by an administrator. */
export async function fetchRequestPolicy(
  apiBaseUrl: string,
  group: string | undefined,
  accessToken?: string | null,
): Promise<RequestPolicy> {
  const suffix = group ? `?group=${encodeURIComponent(group)}` : "";
  const res = await fetch(`${apiBaseUrl}/requests/policy${suffix}`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /requests/policy");
  return toPolicy(await res.json());
}

export async function saveRequestPolicy(
  apiBaseUrl: string,
  policy: RequestPolicy,
  accessToken?: string | null,
): Promise<RequestPolicy> {
  const res = await fetch(`${apiBaseUrl}/requests/policy`, {
    method: "PUT",
    headers: json(accessToken),
    body: JSON.stringify(policy),
  });
  if (!res.ok) throw await readError(res, "PUT /requests/policy");
  return toPolicy(await res.json());
}

/** Every member, with their trust, quota and this week's usage. Administrators only. */
export async function fetchRequestUsers(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<RequestUser[]> {
  const res = await fetch(`${apiBaseUrl}/requests/users`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readError(res, "GET /requests/users");
  return ((await res.json()) as unknown[]).map(toRequestUser);
}

export async function saveRequestUser(
  apiBaseUrl: string,
  userId: string,
  body: { trusted: boolean; weeklyQuota: number },
  accessToken?: string | null,
): Promise<RequestUser> {
  const res = await fetch(
    `${apiBaseUrl}/requests/users/${encodeURIComponent(userId)}`,
    { method: "PUT", headers: json(accessToken), body: JSON.stringify(body) },
  );
  if (!res.ok) throw await readError(res, `PUT /requests/users/${userId}`);
  return toRequestUser(await res.json());
}

/** The caller's in-app notifications. */
export async function fetchNotifications(
  apiBaseUrl: string,
  unreadOnly: boolean,
  accessToken?: string | null,
): Promise<RequestNotification[]> {
  const res = await fetch(
    `${apiBaseUrl}/requests/notifications?unreadOnly=${unreadOnly}`,
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await readError(res, "GET /requests/notifications");
  return ((await res.json()) as unknown[]).map(toNotification);
}

/** Mark notifications read. An empty list means all of the caller's. */
export async function markNotificationsRead(
  apiBaseUrl: string,
  ids: number[],
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/requests/notifications/read`, {
    method: "POST",
    headers: json(accessToken),
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw await readError(res, "POST /requests/notifications/read");
}
