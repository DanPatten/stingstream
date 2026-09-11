import type { paths } from "@stingstream/api-client";
import type { CardData, CardPlaceholder } from "@/components/cards/CardData";
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
 * ## Why the shapes are hand-written and the paths are not
 *
 * `packages/api-client` now carries `RequestsController` (regenerated against a live node), so the
 * *paths* below are pinned to it by [`ROUTES`] and drift is a typecheck failure rather than a 404
 * a user finds. The response *shapes* stay hand-written on purpose: the generated schemas are
 * PascalCase because Swashbuckle reads Jellyfin's serializer options, and typing every screen
 * against that would bake today's answer to the casing question into fifty call sites. The readers
 * here accept either spelling, and `requestsApi.test.ts` asserts both round-trip identically.
 */

/**
 * Every route this file calls, as a suffix of the StingStream API root.
 *
 * The `satisfies` below is the point: it asks TypeScript to prove that each of these, prefixed with
 * `/stingstream/api/v1`, is a real path in the node's own OpenAPI document. Rename a route in
 * `RequestsController`, regenerate, and this file stops compiling — which is the failure everybody
 * wants, instead of a screen that quietly 404s for whoever updates their node first.
 */
const ROUTES = {
  list: "/requests",
  one: "/requests/{id}",
  approve: "/requests/{id}/approve",
  decline: "/requests/{id}/decline",
  retry: "/requests/{id}/retry",
  counts: "/requests/counts",
  search: "/requests/search",
  discover: "/requests/discover",
  policy: "/requests/policy",
  users: "/requests/users",
  user: "/requests/users/{userId}",
  notifications: "/requests/notifications",
  markRead: "/requests/notifications/read",
} as const satisfies Record<string, ApiSuffix>;

/**
 * A suffix that names a real path in the generated OpenAPI document.
 *
 * Distributive on purpose: `Strip<T>` takes a naked type parameter, so the conditional is applied
 * to each member of `keyof paths` and the result is a union of suffixes. Writing the conditional
 * inline over `keyof paths` instead checks the whole union at once, infers `string`, and accepts
 * every typo silently — which it did, until a deliberately broken route failed to fail.
 */
type Strip<T> = T extends `/stingstream/api/v1${infer Suffix}` ? Suffix : never;
type ApiSuffix = Strip<keyof paths>;

/** The states a request moves through. Mirrors `RequestStates` in Core. */
export type RequestState =
  | "pending"
  | "approved"
  | "fulfilling"
  | "available"
  | "declined"
  | "failed"
  | "wanted";

/**
 * How a group fulfils requests.
 *
 * `automatic` is the behaviour that has always existed: a policy decides whether a request needs an
 * administrator, and a node with an indexer goes and gets it. `manual` is a group where nobody has
 * configured an indexer, so nothing is going to search for anything: requests go onto the
 * administrator's list and close themselves once the library serves that title.
 */
export type RequestsMode = "automatic" | "manual";

/**
 * Why somebody asked for a title the library already has.
 *
 * Mirrors `RequestReasons` in Core. The last two act on a file that already exists, which is why
 * they always wait for an administrator whatever the policy says.
 */
export type RequestReason = "missing_episode" | "better_quality" | "bad_copy";

/**
 * Which reasons apply to a kind.
 *
 * A film has no episodes, so it only ever has two. Pure so the picker cannot drift from what the
 * server will accept.
 */
export const reasonsFor = (kind: "movie" | "series"): RequestReason[] =>
  kind === "series"
    ? ["missing_episode", "better_quality", "bad_copy"]
    : ["better_quality", "bad_copy"];

/**
 * Whether a state means somebody is waiting on an administrator's decision.
 *
 * What the manual-mode label hangs off: in a group with no indexer there is no approval to wait
 * for, so these read as waiting rather than naming a queue that is not shown.
 */
export const impliesApproval = (state: RequestState): boolean =>
  state === "pending" || state === "approved";

/** Who may request without asking. Mirrors `AutoApprove` in Core. */
export type AutoApproveMode = "everyone" | "trusted" | "admins_only";

/** One member request, as `RequestsController` shapes it. */
export interface MemberRequest {
  id: string;
  group: string;
  /** `movie` or `series`. */
  kind: "movie" | "series";
  /** The movie's item key, or the prefix a series' episodes share. */
  itemKey: string;
  /** `tmdb` or `tvdb`. */
  provider: string;
  providerId: number;
  title: string;
  year?: number | null;
  posterUrl?: string | null;
  /** The blurb, kept from the search result the request was made from. */
  overview?: string | null;
  /** Seasons the show has, specials excluded. `0` for a movie, and for a request made before this was recorded. */
  seasonCount?: number;
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
  /** Why it was asked for when the library already had it. Absent on an ordinary request. */
  reason?: RequestReason | null;
  /** Anything the requester added in their own words. */
  reasonNote?: string | null;
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
  /** Requests on the wanted list, for an administrator. */
  wanted: number;
  /**
   * How this group fulfils requests.
   *
   * Carried here rather than on an endpoint of its own because every member needs it and every
   * screen that touches requests already polls this. The detailed indexer health behind the
   * administrator's banner is a separate, admin-only call.
   */
  requestsMode: RequestsMode;
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
  /**
   * Seasons this show has, specials excluded. `0` for a movie.
   *
   * Optional because the wire may not carry it: a node built before the field existed sends
   * nothing, and `SeasonPicker` falls back to a fixed range rather than drawing no seasons at all.
   * Anything through `toSearchResult` always has a number.
   */
  seasonCount?: number;
  /**
   * The genres it is filed under, in the metadata provider's own words.
   *
   * What lets the filter bar narrow a search by genre without a second call. Absent on a node built
   * before the field existed, which reads as "no genre" and is therefore never matched by a genre
   * filter rather than wrongly matched by all of them.
   */
  genres?: string[];
  /** The community rating out of ten, when there is one. */
  rating?: number | null;
  /**
   * The IMDb id, `tt` and seven or eight digits, when the lookup carried one.
   *
   * Only ever used to leave: `imdbUrl` sends somebody who taps a score to the page it came from.
   * Absent is normal — an old node does not send it, and the metadata provider does not always know
   * one — and the link falls back to an IMDb search on the title.
   */
  imdbId?: string | null;
  /** Attention on the provider's own scale. Comparable only within one answer. */
  popularity?: number | null;
  /** Length in minutes. An episode's length, for a series. */
  runtime?: number | null;
  /** True when a member of the group already holds it at an acceptable quality. */
  availableInGroup: boolean;
  holders: string[];
  /**
   * The library item to play, when the held copy has resolved to one here.
   *
   * Absent is ordinary rather than an error: a peer's copy becomes an item on this node only once
   * the federated materialiser has caught up. The caller then names the holder and offers no link.
   */
  localItemId?: string | null;
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
  /** The blurb and season count off the search result, so the request keeps them. */
  overview?: string | null;
  seasonCount?: number;
  /** Seasons wanted. Omit or leave empty for all of them. */
  seasons?: number[];
  group?: string;
  title?: string;
  year?: number | null;
  posterUrl?: string | null;
  /**
   * Why this is wanted when the library already has it.
   *
   * Omitted on a first ask. A title the group already holds is refused with what it has and
   * something to play; asking again with this set is how somebody says they want it anyway.
   */
  reason?: RequestReason;
  /** Anything they added in their own words. */
  reasonNote?: string;
}

/** What the server says when the group already holds what was asked for. */
export interface AlreadyHeldAnswer {
  alreadyHeld: true;
  /** Who has it, by display name. */
  holders: string[];
  /** The item to play, when one resolved. */
  playableItemId?: string | null;
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
  overview: field<string>(raw, ...both("overview")),
  seasonCount: field<number>(raw, ...both("seasonCount")) ?? 0,
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
  reason: field<string>(raw, ...both("reason")) as RequestReason | undefined,
  reasonNote: field<string>(raw, ...both("reasonNote")),
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
  wanted: field<number>(raw, ...both("wanted")) ?? 0,
  // Anything that is not the word "manual" is automatic, including the absence of the field. A node
  // built before this existed has an indexer or it does not, but it has always behaved
  // automatically, and reading silence as manual would hide its approval queue on upgrade.
  requestsMode:
    field<string>(raw, ...both("requestsMode")) === "manual"
      ? "manual"
      : "automatic",
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
  seasonCount: field<number>(raw, ...both("seasonCount")) ?? 0,
  genres: field<string[]>(raw, ...both("genres")) ?? [],
  rating: field<number>(raw, ...both("rating")),
  imdbId: field<string>(raw, ...both("imdbId")),
  popularity: field<number>(raw, ...both("popularity")),
  runtime: field<number>(raw, ...both("runtime")),
  availableInGroup: field<boolean>(raw, ...both("availableInGroup")) ?? false,
  holders: field<string[]>(raw, ...both("holders")) ?? [],
  localItemId: field<string>(raw, ...both("localItemId")),
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
 * asked for a movie wants to know it is being downloaded.
 */
export const stateLabel = (state: RequestState): string => {
  switch (state) {
    case "pending":
      return "Waiting for approval";
    // Deliberately says nothing about why. Nobody is searching for this because the group has no
    // indexer, and a member can do nothing about that, so telling them only raises a question they
    // cannot answer.
    case "wanted":
      return "Waiting";
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
    case "wanted":
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

/**
 * Where a score goes when somebody taps it.
 *
 * A number out of ten is a claim, and the useful next question is always "says who" — so the star
 * is a way out to the page the score came from rather than a decoration. The node sends an IMDb id
 * whenever the lookup carried one, which is most of the time; when it did not, the fallback is
 * IMDb's own search for the title and year, which lands one press away from the same page rather
 * than nowhere. `ttype=ft|tv` narrows that search to titles, so a movie does not answer with the
 * actor who shares its name.
 */
export const imdbUrl = (result: {
  title: string;
  year?: number | null;
  kind?: "movie" | "series";
  imdbId?: string | null;
}): string => {
  const id = result.imdbId?.trim();
  if (id) return `https://www.imdb.com/title/${id}/`;
  const term = [result.title, result.year].filter(Boolean).join(" ");
  const type = result.kind === "series" ? "tv" : "ft";
  return `https://www.imdb.com/find/?q=${encodeURIComponent(term)}&s=tt&ttype=${type}`;
};

/** Title and year the way every screen shows it. */
export const requestTitle = (request: {
  title: string;
  year?: number | null;
}): string =>
  request.year ? `${request.title} (${request.year})` : request.title;

/**
 * What pressing the button on a search result should do, and what it should say.
 *
 * The interesting answer is usually "you already have this", and finding that out only after
 * pressing Request is too late to be useful — which is the whole reason the search endpoint
 * annotates every result with the group's holdings.
 *
 * `intent` is the half a screen acts on:
 *
 * * `request` — ask for it.
 * * `manage` — there is already an open request for this title, and the person looking at it can
 *   change or withdraw it.
 * * `duplicate` — the group has it. Still actionable: an episode may be missing, the copy may be
 *   poor, or a better release may exist, and those are the three things the sheet asks about.
 *
 * `duplicate` replaced a dead `none` that disabled the button. A held title is the one case where
 * somebody most often has a real reason to press anyway, and answering "In your library" with no
 * way to say "yes, and the audio is broken" is the gap this closes.
 *
 * A title with a request open used to be `disabled: true` and nothing else, which answered "you
 * asked for this already" and then refused to let anybody act on it: the only way to drop a request
 * or change which seasons it covered was to find it again under My requests. Dan, 2026-09-10:
 * *"if a show is already requested - allow a user to edit the request from the find screen or
 * delete the request - dont just disable the button."* The state moved to the pill beside the
 * title (`searchBadgeLabel`, which already said it) and the button became the action.
 */
export type SearchIntent = "request" | "manage" | "duplicate";

export const searchAction = (
  result: RequestSearchResult,
): { label: string; disabled: boolean; intent: SearchIntent } => {
  // An open request wins over the group holding it. Somebody who already asked for a missing season
  // should be able to edit that request, not be sent round the "you already have this" question
  // again for a title they know the group has.
  switch (result.requestState) {
    case "pending":
      return { label: "Awaiting approval", disabled: false, intent: "manage" };
    // On the wanted list. Nothing is searching for it, so "Already requested" would overstate what
    // is happening, and there is no approval to be awaiting either. It is still the requester's to
    // change or withdraw, which is what manage gets them.
    case "wanted":
      return { label: "Waiting", disabled: false, intent: "manage" };
    case "approved":
    case "fulfilling":
      return { label: "Already requested", disabled: false, intent: "manage" };
    // A declined or failed request is not a reason to refuse a new one: the first was refused by a
    // person who may since have changed their mind, and the second failed for reasons that may
    // have gone away. Asking reopens the request that is already there rather than filing a second
    // one, so the label says "again" — a button reading "Request" on a title the list below still
    // shows as declined invites the press that used to produce the duplicate.
    case "declined":
    case "failed":
      return { label: "Request again", disabled: false, intent: "request" };
    default:
      return result.availableInGroup || result.requestState === "available"
        ? { label: "Request anyway", disabled: false, intent: "duplicate" }
        : { label: "Request", disabled: false, intent: "request" };
  }
};

/**
 * The corner badge a Discover poster carries — `CardArtwork`'s `badgeLabel`, drawn as a solid
 * accent pill over the artwork. `searchAction` answers the same question for the button under the
 * card; this is the tile's own, shorter answer, and `null` means an untouched title carries none.
 *
 * Two words at most: `CardArtwork` positions the badge against the artwork's right edge with no
 * width limit of its own, so on the smallest poster this app draws (`RequestSheet`'s 96 px detail
 * poster) anything longer overflows past the artwork's left edge before the container's
 * `overflow: hidden` catches it — confirmed live. "In library" mirrors `docs/REQUESTS.md`'s own
 * "already in your library" wording, which is also the short one.
 */
export const searchBadgeLabel = (
  result: RequestSearchResult,
): string | null => {
  // Held somewhere in the group already — the whole reason Discover annotates results instead of
  // letting a member find out only after pressing Request.
  if (result.availableInGroup || result.requestState === "available") {
    return "In library";
  }
  switch (result.requestState) {
    case "pending":
    case "approved":
    case "fulfilling":
      return "Requested";
    // Declined and failed are not a permanent no — see `searchAction` — so neither badges the
    // card, which would read as "do not ask again".
    default:
      return null;
  }
};

const kindPlaceholder = (kind: "movie" | "series"): CardPlaceholder =>
  kind === "series" ? "series" : "movie";

/**
 * `RequestSearchResult` carries `availableInGroup`; `MemberRequest` never does. A real type guard
 * rather than a boolean handed to a ternary — TypeScript only narrows `source` at the site of the
 * `in` check itself, not through a variable that remembers the answer.
 */
const isSearchResult = (
  source: RequestSearchResult | MemberRequest,
): source is RequestSearchResult => "availableInGroup" in source;

/**
 * A search result or a member's own request, as `CardData` — the shape Discover's poster grid and
 * its skeletons understand (`components/cards/*`). Kept here rather than in a component: a pure
 * mapping over the wire shape is what `requestsApi.test.ts` can pin without loading React Native.
 *
 * `id` is the item key for a search result — it has no request row yet — and the request's own id
 * once one exists, so a card stays keyed on the same value across a refetch either way.
 */
/**
 * A request, in the shape the request sheet reads.
 *
 * My requests holds `MemberRequest` rows and the sheet is written against a search result, because
 * that is where a request is normally made from. Rather than teach the sheet a second shape, the
 * row is mapped onto the one it already knows: the ids come off `provider`/`providerId`, and the
 * request's own state and id come with it so the sheet opens in edit mode.
 *
 * The blurb and the season count come off the request itself: both are captured when it is made and
 * kept on the row, because there is nowhere else to read them later. A request made before they were
 * recorded has neither, and the sheet degrades the way it used to — no blurb, and the picker's fixed
 * range instead of the show's real seasons.
 */
export const requestAsSearchResult = (
  request: MemberRequest,
): RequestSearchResult => ({
  kind: request.kind,
  title: request.title,
  year: request.year,
  overview: request.overview ?? null,
  posterUrl: request.posterUrl,
  tmdbId: request.provider === "tmdb" ? request.providerId : 0,
  tvdbId: request.provider === "tvdb" ? request.providerId : 0,
  itemKey: request.itemKey,
  seasonCount: request.seasonCount ?? 0,
  availableInGroup: false,
  holders: [],
  requestState: request.state,
  requestId: request.id,
});

export const toRequestCard = (
  source: RequestSearchResult | MemberRequest,
): CardData =>
  isSearchResult(source)
    ? {
        id:
          source.itemKey || `${source.kind}:${source.tmdbId || source.tvdbId}`,
        title: source.title,
        subtitle: source.year ? String(source.year) : null,
        imageUrl: source.posterUrl,
        imageAlt: requestTitle(source),
        badgeLabel: searchBadgeLabel(source),
        placeholder: kindPlaceholder(source.kind),
        // What the provider's own audience made of it, out of ten. The one
        // thing a poster cannot tell you and the reason half these presses
        // happen: sixty strangers on a page, and this is what sorts them.
        rating: source.rating,
      }
    : {
        id: source.id,
        title: source.title,
        subtitle: source.year ? String(source.year) : null,
        imageUrl: source.posterUrl,
        imageAlt: requestTitle(source),
        badgeLabel: stateLabel(source.state),
        placeholder: kindPlaceholder(source.kind),
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

// --- is this the same title? ----------------------------------------------------------------------

/**
 * The Requests page asks the node for one term and the node asks *both* arrs, so a title that
 * exists as a movie and as a series — or one movie listed under two ids by the same provider — comes
 * back twice. Everything in this block decides when two answers are the same title, and it lives
 * here rather than in a component because it is pure and `requestsApi.test.ts` can pin it.
 *
 * The identity of a title is a *set* of keys rather than one id, because the sources do not always
 * agree on which id they carry: a movie lookup comes back keyed on TMDB, a series lookup on
 * TheTVDB, and a Jellyfin item carries whatever the metadata provider wrote into `ProviderIds` —
 * often TMDB and IMDb, sometimes neither. Matching on any single one of them would list the same
 * movie twice in a row, which is what makes a result list look like it is not to be trusted.
 */

/** Case, punctuation and spacing removed, so "WALL·E" and "Wall-E" are the same title. */
const normalisedTitle = (title: string | null | undefined): string =>
  (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * `tmdb:603`. `null` when either half is missing — the arrs send `0` for an id they do not have,
 * and a key of `tmdb:0` would match every other title that also has no TMDB id.
 */
export const providerKey = (
  provider: string | null | undefined,
  id: number | string | null | undefined,
): string | null => {
  const name = (provider ?? "").trim().toLowerCase();
  const value = String(id ?? "").trim();
  if (!name || !value || value === "0") return null;
  return `${name}:${value}`;
};

/**
 * `movie:alien:1979` — the fallback for a library item whose `ProviderIds` are empty, which is the
 * normal state of anything added before its metadata was fetched.
 *
 * The year is required and the kind is part of the key: "Alien" with no year would match the
 * series, the 1979 movie and the 2026 one all at once, and hiding a title the user *can* ask for is
 * a worse failure than showing one they cannot.
 */
export const titleKey = (
  kind: "movie" | "series",
  title: string | null | undefined,
  year: number | null | undefined,
): string | null => {
  const name = normalisedTitle(title);
  if (!name || !year) return null;
  return `${kind}:${name}:${year}`;
};

/** Every key one catalogue result can be recognised by. */
export const searchResultKeys = (result: RequestSearchResult): string[] =>
  [
    providerKey("tmdb", result.tmdbId),
    providerKey("tvdb", result.tvdbId),
    titleKey(result.kind, result.title, result.year),
  ].filter((key): key is string => key !== null);

/** Every key one member request can be recognised by. */
export const memberRequestKeys = (request: MemberRequest): string[] =>
  [
    providerKey(request.provider, request.providerId),
    titleKey(request.kind, request.title, request.year),
  ].filter((key): key is string => key !== null);

/**
 * The subset of `BaseItemDto` this comparison reads. Stated structurally so nothing in this file
 * has to import the Jellyfin SDK: `requestsApi.ts` is the half of the feature `bun:test` can load,
 * and that only stays true while its imports are types the compiler erases.
 */
export interface LibraryIdentity {
  Type?: string | null;
  Name?: string | null;
  ProductionYear?: number | null;
  ProviderIds?: { [key: string]: string | null } | null;
}

/**
 * Whether Search should offer to go and ask for what was typed.
 *
 * Search answers with the library and nothing else, so the one thing it cannot do is tell you that
 * a title exists at all. The offer is the bridge, and the rule for showing it is "a fuzzy match or
 * no matches": the library came back with nothing, or with things that are *near* what was typed
 * without being it. Typing "alien" and getting "Alien" back is an answer; typing "aliens" and
 * getting "Alien" back is a near miss, and a near miss is exactly when somebody wants to ask.
 *
 * Compared on the normalised title alone — not title-and-year like {@link titleKey} — because a
 * person types "wall-e", not "wall-e (2008)", and requiring the year would offer to request
 * something that is plainly sitting in the results.
 *
 * Feed it the movie and series results only, for the same reason {@link searchResultKeys} keeps to
 * whole titles: an episode's `Name` is the episode's own, so "Pilot" would count as an exact match
 * for a search for a show called Pilot and silently withdraw the offer.
 */
export const shouldOfferRequest = (
  term: string,
  items: readonly LibraryIdentity[],
): boolean => {
  const wanted = normalisedTitle(term);
  // Nothing typed is not a fuzzy match, it is no question yet.
  if (!wanted) return false;
  return !items.some((item) => normalisedTitle(item.Name) === wanted);
};

/**
 * Search results as the Find list draws them: each title once, and each annotated with the state of
 * a request the member has already made for it.
 *
 * The node asks both arrs and hands back everything either matched, so a title that exists as a
 * movie and as a series comes back twice, as does one movie listed under two ids by the same
 * provider. Order is the node's — movies first — and the first answer for a title wins, so
 * narrowing to Movies or Series never reorders what stays.
 *
 * `myRequests` fills in a `requestState` the node did not send. It normally does send one — the
 * search endpoint annotates every result from its own store — but that annotation is a round trip
 * behind the mutation that created the request, and a row that still says "Request" for a second
 * after you asked for it reads as a button that did nothing.
 */
export const dedupeSearchResults = (
  results: readonly RequestSearchResult[],
  myRequests: readonly MemberRequest[] = [],
): RequestSearchResult[] => {
  const mine = new Map<string, MemberRequest>();
  for (const request of myRequests) {
    for (const key of memberRequestKeys(request)) {
      if (!mine.has(key)) mine.set(key, request);
    }
  }

  const seen = new Set<string>();
  const rows: RequestSearchResult[] = [];

  for (const result of results) {
    const keys = searchResultKeys(result);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);

    let known = result;
    if (!known.requestState) {
      const request = keys
        .map((key) => mine.get(key))
        .find((found) => found !== undefined);
      if (request) {
        known = {
          ...known,
          requestState: request.state,
          requestId: request.id,
        };
      }
    }

    rows.push(known);
  }

  return rows;
};

// --- calls --------------------------------------------------------------------------------------

/**
 * The requests feature is not turned on for this node: `RequestsController` answers 503 rather
 * than an empty body when its own service can't be reached, the same distinction `meshApi.ts`'s
 * `MeshUnavailableError` exists for — "nothing has been asked for" and "I could not ask" look
 * identical in a body and mean opposite things. Every screen catches this one specifically and
 * shows "Requests are not set up on this server." instead of a generic error with a Retry button
 * that would only fail the same way again.
 */
export class RequestsUnavailableError extends Error {
  readonly unavailable = true;
}

/** `readError`, with the 503 case reworded for what it actually means on this API. */
const readRequestsError = async (
  res: Response,
  what: string,
): Promise<Error> => {
  if (res.status === 503) {
    return new RequestsUnavailableError(
      "Requests are not set up on this server.",
    );
  }
  return readError(res, what);
};

const json = (accessToken?: string | null): Record<string, string> => ({
  ...authHeaders(accessToken),
  "Content-Type": "application/json",
});

/**
 * Build a request URL from a [`ROUTES`] entry, filling in its `{placeholders}`.
 *
 * Going through this rather than interpolating a path literal at each call site is what makes the
 * `satisfies` on `ROUTES` mean anything: a literal typed in here would not be checked against the
 * OpenAPI document at all.
 */
const url = (
  apiBaseUrl: string,
  route: (typeof ROUTES)[keyof typeof ROUTES],
  params: Record<string, string> = {},
  query?: URLSearchParams,
): string => {
  const path = (route as string).replace(/\{(\w+)\}/g, (_match, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
  const suffix = query?.toString();
  return `${apiBaseUrl}${path}${suffix ? `?${suffix}` : ""}`;
};

/** Requests. `mine` is forced on for a non-administrator by Core, whatever is passed. */
export async function fetchRequests(
  apiBaseUrl: string,
  options: { mine?: boolean; state?: RequestState } = {},
  accessToken?: string | null,
): Promise<MemberRequest[]> {
  const query = new URLSearchParams();
  if (options.mine !== undefined) query.set("mine", String(options.mine));
  if (options.state) query.set("state", options.state);
  const res = await fetch(url(apiBaseUrl, ROUTES.list, {}, query), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readRequestsError(res, "GET /requests");
  return ((await res.json()) as unknown[]).map(toRequest);
}

/** One request with its trail. */
export async function fetchRequest(
  apiBaseUrl: string,
  id: string,
  accessToken?: string | null,
): Promise<RequestDetail> {
  const res = await fetch(url(apiBaseUrl, ROUTES.one, { id }), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readRequestsError(res, `GET /requests/${id}`);
  return toRequestDetail(await res.json());
}

/** Badge counts. */
export async function fetchRequestCounts(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<RequestCounts> {
  const res = await fetch(url(apiBaseUrl, ROUTES.counts), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readRequestsError(res, "GET /requests/counts");
  return toCounts(await res.json());
}

/**
 * Whether this node can be asked for anything at all.
 *
 * `GET /requests/search` refuses with 503 before it looks anything up when neither manager is
 * configured (`RequestService.CanSearch`), and answers an empty list for an empty term without
 * touching either of them. An empty search is therefore a free capability probe: no metadata
 * lookup, no group-index scan, one round trip, and the two answers are exactly "requests are set
 * up here" and "they are not".
 *
 * It is the only endpoint in the feature that can say so. `/requests`, `/requests/counts` and the
 * rest answer perfectly good empty lists and zero counts on a node with no arrs at all, which is
 * why the screen used to look merely empty rather than unset-up until somebody typed a search.
 *
 * Anything other than a 503 counts as available: a network failure or a 500 is a broken node, not
 * an unconfigured one, and blocking the whole screen on a flaky probe would hide the sections that
 * can still say what went wrong.
 */
export async function fetchRequestsAvailable(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<boolean> {
  const res = await fetch(
    url(apiBaseUrl, ROUTES.search, {}, new URLSearchParams({ q: "" })),
    { headers: authHeaders(accessToken) },
  );
  return res.status !== 503;
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
  const res = await fetch(url(apiBaseUrl, ROUTES.search, {}, query), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readRequestsError(res, "GET /requests/search");
  return ((await res.json()) as unknown[]).map(toSearchResult);
}

/** Ask for something. */
export async function createRequest(
  apiBaseUrl: string,
  input: CreateRequestInput,
  accessToken?: string | null,
): Promise<MemberRequest> {
  const res = await fetch(url(apiBaseUrl, ROUTES.list), {
    method: "POST",
    headers: json(accessToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readRequestsError(res, "POST /requests");
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
  const route =
    decision === "approve"
      ? ROUTES.approve
      : decision === "decline"
        ? ROUTES.decline
        : ROUTES.retry;
  const res = await fetch(url(apiBaseUrl, route, { id }), {
    method: "POST",
    headers: json(accessToken),
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok)
    throw await readRequestsError(res, `POST /requests/${id}/${decision}`);
  return toRequest(await res.json());
}

/**
 * Replace the seasons an open request is for.
 *
 * Not in `ROUTES`, and deliberately: that object's `satisfies` proves every path against
 * `packages/api-client/openapi.json`, and this route is newer than the last time that document was
 * regenerated. Regenerating it means running a node built from this working tree, which on a shared
 * checkout picks up whatever other controllers are half-written at that moment — the note
 * `downloadingApi.ts` records at length. The path is pinned by `RequestsController.SetSeasons`'s
 * own route attribute; fold it into `ROUTES` the next time the document is regenerated for other
 * reasons.
 *
 * An empty list means every season, the same as everywhere else in this module.
 */
/**
 * The request finished before the edit reached it.
 *
 * Its own type so a caller can act on it rather than print it. A request finishes on its own -- a
 * node with no indexer fails one within seconds -- so a sheet opened on an open request can be
 * saved against a finished one through no fault of the person pressing Save. Showing them "This
 * request has already finished" is a refusal for something they did not do; asking again, which
 * reopens the same row, is what they meant.
 */
export class RequestFinishedError extends Error {
  readonly finished = true;
}

export async function setRequestSeasons(
  apiBaseUrl: string,
  id: string,
  seasons: number[],
  accessToken?: string | null,
): Promise<MemberRequest> {
  const res = await fetch(
    `${apiBaseUrl}/requests/${encodeURIComponent(id)}/seasons`,
    {
      method: "PUT",
      headers: {
        ...authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seasons }),
    },
  );
  if (res.status === 409) {
    throw new RequestFinishedError("This request has already finished.");
  }
  if (!res.ok)
    throw await readRequestsError(res, `PUT /requests/${id}/seasons`);
  return toRequest(await res.json());
}

/** Withdraw a request. */
export async function deleteRequest(
  apiBaseUrl: string,
  id: string,
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(url(apiBaseUrl, ROUTES.one, { id }), {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readRequestsError(res, `DELETE /requests/${id}`);
}

/** The group's policy. Readable by every member; writable only by an administrator. */
export async function fetchRequestPolicy(
  apiBaseUrl: string,
  group: string | undefined,
  accessToken?: string | null,
): Promise<RequestPolicy> {
  const query = group ? new URLSearchParams({ group }) : undefined;
  const res = await fetch(url(apiBaseUrl, ROUTES.policy, {}, query), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readRequestsError(res, "GET /requests/policy");
  return toPolicy(await res.json());
}

export async function saveRequestPolicy(
  apiBaseUrl: string,
  policy: RequestPolicy,
  accessToken?: string | null,
): Promise<RequestPolicy> {
  const res = await fetch(url(apiBaseUrl, ROUTES.policy), {
    method: "PUT",
    headers: json(accessToken),
    body: JSON.stringify(policy),
  });
  if (!res.ok) throw await readRequestsError(res, "PUT /requests/policy");
  return toPolicy(await res.json());
}

/** Every member, with their trust, quota and this week's usage. Administrators only. */
export async function fetchRequestUsers(
  apiBaseUrl: string,
  accessToken?: string | null,
): Promise<RequestUser[]> {
  const res = await fetch(url(apiBaseUrl, ROUTES.users), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw await readRequestsError(res, "GET /requests/users");
  return ((await res.json()) as unknown[]).map(toRequestUser);
}

export async function saveRequestUser(
  apiBaseUrl: string,
  userId: string,
  body: { trusted: boolean; weeklyQuota: number },
  accessToken?: string | null,
): Promise<RequestUser> {
  const res = await fetch(url(apiBaseUrl, ROUTES.user, { userId }), {
    method: "PUT",
    headers: json(accessToken),
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw await readRequestsError(res, `PUT /requests/users/${userId}`);
  return toRequestUser(await res.json());
}

/** The caller's in-app notifications. */
export async function fetchNotifications(
  apiBaseUrl: string,
  unreadOnly: boolean,
  accessToken?: string | null,
): Promise<RequestNotification[]> {
  const query = new URLSearchParams({ unreadOnly: String(unreadOnly) });
  const res = await fetch(url(apiBaseUrl, ROUTES.notifications, {}, query), {
    headers: authHeaders(accessToken),
  });
  if (!res.ok)
    throw await readRequestsError(res, "GET /requests/notifications");
  return ((await res.json()) as unknown[]).map(toNotification);
}

/** Mark notifications read. An empty list means all of the caller's. */
export async function markNotificationsRead(
  apiBaseUrl: string,
  ids: number[],
  accessToken?: string | null,
): Promise<void> {
  const res = await fetch(url(apiBaseUrl, ROUTES.markRead), {
    method: "POST",
    headers: json(accessToken),
    body: JSON.stringify({ ids }),
  });
  if (!res.ok)
    throw await readRequestsError(res, "POST /requests/notifications/read");
}

// --- browsing -----------------------------------------------------------------------------------

/** A page of the catalogue, with the options its genre chip offers. */
export interface RequestDiscoverPage {
  results: RequestSearchResult[];
  page: number;
  genres: string[];
}

export const toDiscoverPage = (raw: unknown): RequestDiscoverPage => ({
  results: (field<unknown[]>(raw, ...both("results")) ?? []).map(
    toSearchResult,
  ),
  page: field<number>(raw, ...both("page")) ?? 1,
  genres: field<string[]>(raw, ...both("genres")) ?? [],
});

/** All, or one kind. */
export type RequestKind = "all" | "movie" | "series";

/** How the catalogue is ordered. `popular` is the default on both screens. */
export type RequestSort = "popular" | "top_rated" | "newest" | "title";

/** Which way round. */
export type RequestOrder = "asc" | "desc";

/** What the group already thinks about a title, as something to narrow by. */
export type RequestAvailability = "held" | "not_held" | "requested";

/**
 * Everything the Find bar is currently narrowing by.
 *
 * The list-shaped fields are lists because that is what a `FilterButton` hands back, not because
 * more than one can be chosen: the chips are single-select, exactly as a library's are.
 */
export interface RequestFilterState {
  kind: RequestKind;
  genres: string[];
  years: string[];
  availability: RequestAvailability[];
  sortBy: RequestSort[];
  sortOrder: RequestOrder[];
}

export const DEFAULT_REQUEST_FILTERS: RequestFilterState = {
  kind: "all",
  genres: [],
  years: [],
  availability: [],
  sortBy: ["popular"],
  sortOrder: ["desc"],
};

/**
 * Whether anything is actually narrowing what is on screen.
 *
 * Drives the Clear chip, so it has to agree with the defaults above exactly: a bar that opens with
 * Clear already showing is a bar offering to undo something nobody did.
 */
export const requestFiltersActive = (state: RequestFilterState): boolean =>
  state.kind !== DEFAULT_REQUEST_FILTERS.kind ||
  state.genres.length > 0 ||
  state.years.length > 0 ||
  state.availability.length > 0 ||
  state.sortBy[0] !== DEFAULT_REQUEST_FILTERS.sortBy[0] ||
  state.sortOrder[0] !== DEFAULT_REQUEST_FILTERS.sortOrder[0];

/** The query the node's catalogue takes for this state. */
export const discoverQuery = (
  state: RequestFilterState,
  page = 1,
): Record<string, string> => {
  const query: Record<string, string> = {
    sort: state.sortBy[0] ?? "popular",
    order: state.sortOrder[0] ?? "desc",
    page: String(page),
  };
  if (state.kind !== "all") query.kind = state.kind;
  if (state.genres.length > 0) query.genres = state.genres.join(",");
  if (state.years.length > 0) query.year = state.years[0];
  return query;
};

/**
 * Narrow and reorder a list of results by the bar above it.
 *
 * **The two screens filter in different places and this is the same rule in both.** The feed hands
 * genre, year and order to the node, because the fifty titles it draws have to be the top fifty of
 * that slice rather than the top fifty of everything with the rest thrown away. A search cannot
 * work that way: the answer is whatever matched what you typed, and re-asking the catalogue with
 * the term would be a different search rather than a narrower one. So the search narrows here.
 * Running the feed through this as well costs nothing — the node has already applied most of it —
 * and is what makes Availability, which the node cannot answer, work on both.
 *
 * The default sort deliberately does *not* reorder. A search's own order is relevance, and the
 * reader has not asked for anything else yet; sorting by popularity the moment the screen opens
 * would push the show somebody typed the name of below a dozen movies that outrank it.
 */
export const applyRequestFilters = (
  results: readonly RequestSearchResult[],
  state: RequestFilterState,
): RequestSearchResult[] => {
  const genres = state.genres.map((genre) => genre.toLowerCase());
  const years = new Set(state.years);
  const availability = state.availability[0];

  const kept = results.filter((result) => {
    if (state.kind !== "all" && result.kind !== state.kind) return false;
    if (
      genres.length > 0 &&
      !(result.genres ?? []).some((genre) =>
        genres.includes(genre.toLowerCase()),
      )
    ) {
      return false;
    }
    if (years.size > 0 && !years.has(String(result.year ?? ""))) return false;
    if (availability === "held" && !result.availableInGroup) return false;
    if (availability === "not_held" && result.availableInGroup) return false;
    if (availability === "requested" && !result.requestState) return false;
    return true;
  });

  const sort = state.sortBy[0] ?? "popular";
  if (sort === "popular") return kept;

  const descending = (state.sortOrder[0] ?? "desc") === "desc";
  const sorted = [...kept].sort((a, b) => {
    switch (sort) {
      case "top_rated":
        return (b.rating ?? 0) - (a.rating ?? 0);
      case "newest":
        return (b.year ?? 0) - (a.year ?? 0);
      default:
        return b.title.localeCompare(a.title, undefined, {
          sensitivity: "base",
        });
    }
  });
  return descending ? sorted : sorted.reverse();
};

/** Browse the catalogue: what is popular now, or the best ever made. */
export async function discoverRequestable(
  apiBaseUrl: string,
  state: RequestFilterState,
  page: number,
  accessToken?: string | null,
): Promise<RequestDiscoverPage> {
  const res = await fetch(
    url(
      apiBaseUrl,
      ROUTES.discover,
      {},
      new URLSearchParams(discoverQuery(state, page)),
    ),
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw await readRequestsError(res, "GET /requests/discover");
  return toDiscoverPage(await res.json());
}
